import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useActor } from './actorContext'
import { api, type Batch, type Product } from './api'

export const useBatches = () => useQuery({ queryKey: ['batches'], queryFn: api.batches })

export const useBatch = (id: number) => useQuery({ queryKey: ['batch', id], queryFn: () => api.batch(id) })

export const useProduct = (id: number | null) =>
  useQuery({ queryKey: ['product', id], queryFn: () => api.product(id!), enabled: id !== null })

export const useVocab = (group: string | undefined) =>
  useQuery({ queryKey: ['vocab', group], queryFn: () => api.vocab(group!), enabled: !!group, staleTime: Infinity })

/** A change to one product: the API returns the product, which replaces it in the cached batch. */
export function useProductMutation<A>(batchId: number, fn: (args: A) => Promise<Product>) {
  const client = useQueryClient()
  const { ensure } = useActor()
  return useMutation({
    mutationFn: async (args: A) => {
      if (!(await ensure())) throw new Error('Без име решението не се записва.')
      return fn(args)
    },
    onSuccess: (product) => {
      client.setQueryData<Batch>(['batch', batchId], (old) =>
        old ? { ...old, products: old.products.map((p) => (p.id === product.id ? product : p)) } : old,
      )
      client.setQueryData(['product', product.id], { ...product, batch_id: batchId })
      client.invalidateQueries({ queryKey: ['batches'] })
      client.invalidateQueries({ queryKey: ['audit', batchId] })
    },
  })
}

export type DecideArgs = { fieldId: number; action: 'accept' | 'edit' | 'pick'; value?: unknown }

export const useDecide = (batchId: number) =>
  useProductMutation<DecideArgs>(batchId, ({ fieldId, action, value }) => api.decide(fieldId, action, value))

export const useAcceptAll = (batchId: number) =>
  useProductMutation<{ productId: number; store?: string }>(batchId, ({ productId, store }) =>
    api.acceptAll(productId, store),
  )

export const useApprove = (batchId: number) =>
  useProductMutation<number>(batchId, (productId) => api.approve(productId))

export function useAcceptColumn(batchId: number) {
  const client = useQueryClient()
  const { ensure } = useActor()
  return useMutation({
    mutationFn: async ({ store, key }: { store: string; key: string }) => {
      if (!(await ensure())) throw new Error('Без име решението не се записва.')
      return api.acceptColumn(batchId, store, key)
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['batch', batchId] })
      client.invalidateQueries({ queryKey: ['batches'] })
    },
  })
}

// The running new batch, else the last one this server ran: kept in the server's memory, lost on a deploy.
export const useLatestJob = () =>
  useQuery({
    queryKey: ['job', 'latest'],
    queryFn: api.latestJob,
    refetchInterval: (query) => (query.state.data?.running ? 5000 : false),
  })

export const useUploadState = (batchId: number) =>
  useQuery({
    queryKey: ['upload', batchId],
    queryFn: () => api.uploadState(batchId),
    refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
  })

export function useStartUpload(batchId: number) {
  const client = useQueryClient()
  const { ensure } = useActor()
  return useMutation({
    mutationFn: async (body: { status: 'draft' | 'active'; stores?: string[]; only_failed?: boolean }) => {
      if (!(await ensure())) throw new Error('Без име качването не се записва.')
      return api.startUpload(batchId, body)
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['upload', batchId] })
      client.invalidateQueries({ queryKey: ['batches'] })
    },
  })
}

export const useStores = () => useQuery({ queryKey: ['stores'], queryFn: api.stores })

export const useProfile = (id: number) => useQuery({ queryKey: ['profile', id], queryFn: () => api.profile(id) })

/** Writes that need a name, then refresh the stores list and this profile. */
export function useStoreMutation<A, R>(fn: (args: A) => Promise<R>) {
  const client = useQueryClient()
  const { ensure } = useActor()
  return useMutation({
    mutationFn: async (args: A) => {
      if (!(await ensure())) throw new Error('Без име промяната не се записва.')
      return fn(args)
    },
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ['stores'] })
      client.invalidateQueries({ queryKey: ['batches'] })
      client.invalidateQueries({ queryKey: ['profile'] })
      if (result && typeof result === 'object' && 'id' in result && 'store' in result)
        client.setQueryData(['profile', (result as { id: number }).id], result)
    },
  })
}

export const useAudit = (batchId: number) => useQuery({ queryKey: ['audit', batchId], queryFn: () => api.audit(batchId) })

export const useAuditItems = (batchId: number, rule: string | null, limit: number) =>
  useQuery({
    queryKey: ['audit', batchId, rule, limit],
    queryFn: () => api.auditItems(batchId, rule!, limit),
    enabled: !!rule,
    // Keep the list while "show more" loads, never another rule's list (a click would hit the wrong row).
    placeholderData: (previous, query) => (query?.queryKey[2] === rule ? previous : undefined),
  })
