// Types and calls for the review API (api/review.py). The reviewer's name goes in X-Actor (URL-encoded).

export type Status = 'ok' | 'suggested' | 'fixed' | 'warning' | 'blocked'
export type ProductState = 'ready' | 'review' | 'blocked'

export type Source = { url?: string; title?: string; says?: string; width?: number; height?: number; error?: string }
export type Issue = { status: Status; rule: string; message: string }

export type FieldRecord = {
  id: number
  key: string
  value: unknown
  origin: 'input' | 'template' | 'vocab' | 'ai_research' | 'ai_generated' | 'auto_fix'
  status: Status
  confidence: number | null
  sources: Source[]
  alternatives: unknown[]
  previous: unknown
  value_en: string | null
  message: string | null
  issues: Issue[]
  decided_by: string | null
  decided_at: string | null
}

export type StoreProduct = {
  store_product_id: number
  approved_by: string | null
  approved_at: string | null
  status: Status
  fields: Record<string, FieldRecord>
}

export type MediaRecord = {
  id: number
  url: string
  kind: 'original' | 'composed'
  layout: string | null
  source_url: string | null
  width: number
  height: number
  info: { bottle?: [number, number]; scaled?: number; warnings?: string[]; source?: string }
}

export type Product = {
  id: number
  ean: string | null
  input: Record<string, unknown>
  title: string
  state: ProductState
  counts: Partial<Record<Status, number>>
  stores: Record<string, StoreProduct>
  media: MediaRecord[]
}

export type StoreInfo = {
  key: string
  label: string
  country: string | null
  language: string | null
  currency: string | null
}

export type BatchSummary = {
  id: number
  kind: 'new' | 'audit'
  name: string
  group: string
  created_at: string
  author: string | null
  publish_status: string
  stores: StoreInfo[]
  products: number
  ready: number
  review: number
  blocked: number
  approved: number
  fixed: number
}

export type Batch = {
  id: number
  kind: 'new' | 'audit'
  name: string
  group: string
  created_at: string
  author: string | null
  stores: StoreInfo[]
  products: Product[]
}

const ACTOR_KEY = 'perfume-import.actor'

export function getActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setActor(name: string) {
  try {
    localStorage.setItem(ACTOR_KEY, name)
  } catch {
    // Private mode: the name lives only in this tab.
  }
}

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-Actor': encodeURIComponent(getActor()), ...init?.headers },
    })
  } catch {
    throw new ApiError('Няма връзка с API-то. Провери, че сървърът работи, и опитай отново.')
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.json()).detail ?? ''
    } catch {
      // Not JSON: keep the status text.
    }
    throw new ApiError(detail || `API-то отговори с ${response.status} ${response.statusText}.`)
  }
  return response.json() as Promise<T>
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  batches: () => request<BatchSummary[]>('/api/batches'),
  batch: (id: number) => request<Batch>(`/api/batches/${id}`),
  vocab: (group: string) => request<Record<string, string[]>>(`/api/groups/${group}/vocab`),
  decide: (fieldId: number, action: 'accept' | 'edit' | 'pick', value?: unknown) =>
    post<Product>(`/api/fields/${fieldId}/decision`, { action, value }),
  acceptAll: (productId: number, store?: string) => post<Product>(`/api/products/${productId}/accept-all`, { store }),
  approve: (productId: number) => post<Product>(`/api/products/${productId}/approve`, {}),
  acceptColumn: (batchId: number, store: string, key: string) =>
    post<{ accepted: number }>(`/api/batches/${batchId}/accept-column`, { store, key }),
}
