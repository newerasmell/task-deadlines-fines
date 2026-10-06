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

export type UploadItem = {
  store_product_id: number
  product_id: number
  title: string
  blocker: string | null
  upload_status: 'uploaded' | 'failed' | null
  upload_message: string | null
  attempted_at: string | null
  shopify_url: string | null
}

export type UploadStore = {
  key: string
  label: string
  language: string | null
  country: string | null
  configured: string | null
  items: UploadItem[]
}

export type UploadState = {
  batch_id: number
  kind: 'new' | 'audit'
  publish_status: string
  running: boolean
  done: number
  total: number
  error: string | null
  stores: UploadStore[]
}

export type StoreRow = {
  key: string
  label: string
  group: string | null
  country: string | null
  language: string | null
  currency: string | null
  shop: string | null
  access: string | null
  state: 'active' | 'proposed' | 'waiting'
  products: number | null
  catalog_at: string | null
  profile_id: number | null
  audit_batch_id: number | null
}

export type ProfileItem = {
  value: unknown
  match_rate?: number | null
  status?: string
  examples?: unknown[]
  [k: string]: unknown
}

export type GroupScore = {
  group: string | null
  name: string
  score: number | null
  recommended: boolean
  comparable: boolean
  reasons: string[]
}

export type StoreProfile = {
  id: number
  store: string
  label: string
  group: string | null
  shop: string | null
  access_env: { client_id: string; client_secret: string; token: string | null }
  version: number
  state: 'proposed' | 'accepted' | 'rejected'
  created_at: string
  decided_by: string | null
  source: string | null
  diff: { first: boolean; changed: { key: string; before: unknown; after: unknown }[] } | null
  audit_batch_id: number | null
  profile: {
    products: number
    columns: string[]
    to_confirm: string[]
    group_scores: GroupScore[]
    items: Record<string, ProfileItem | Record<string, ProfileItem>>
  }
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

async function upload<T>(path: string, form: FormData): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { method: 'POST', body: form, headers: { 'X-Actor': encodeURIComponent(getActor()) } })
  } catch {
    throw new ApiError('Няма връзка с API-то. Провери, че сървърът работи, и опитай отново.')
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.json()).detail ?? ''
    } catch {
      // Not JSON.
    }
    throw new ApiError(typeof detail === 'string' && detail ? detail : `API-то отговори с ${response.status}.`)
  }
  return response.json() as Promise<T>
}

const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) })

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  batches: () => request<BatchSummary[]>('/api/batches'),
  batch: (id: number) => request<Batch>(`/api/batches/${id}`),
  vocab: (group: string) => request<Record<string, string[]>>(`/api/groups/${group}/vocab`),
  decide: (fieldId: number, action: 'accept' | 'edit' | 'pick', value?: unknown) =>
    post<Product>(`/api/fields/${fieldId}/decision`, { action, value }),
  acceptAll: (productId: number, store?: string) => post<Product>(`/api/products/${productId}/accept-all`, { store }),
  approve: (productId: number) => post<Product>(`/api/products/${productId}/approve`, {}),
  stores: () => request<StoreRow[]>('/api/stores'),
  analyze: (form: FormData) => upload<{ profile_id: number }>('/api/stores/analyze', form),
  profile: (id: number) => request<StoreProfile>(`/api/profiles/${id}`),
  editProfileItem: (id: number, key: string, value: unknown) =>
    put<StoreProfile>(`/api/profiles/${id}/items/${encodeURIComponent(key)}`, { value }),
  acceptProfile: (id: number, group: string | null) => post<StoreProfile>(`/api/profiles/${id}/accept`, { group }),
  rejectProfile: (id: number) => post<StoreProfile>(`/api/profiles/${id}/reject`, {}),
  setShop: (store: string, shop: string) => put<{ ok: boolean }>(`/api/stores/${store}/shop`, { shop }),
  uploadState: (batchId: number) => request<UploadState>(`/api/batches/${batchId}/upload`),
  startUpload: (batchId: number, body: { status: 'draft' | 'active'; stores?: string[]; only_failed?: boolean }) =>
    post<{ started: boolean }>(`/api/batches/${batchId}/upload`, body),
  acceptColumn: (batchId: number, store: string, key: string) =>
    post<{ accepted: number }>(`/api/batches/${batchId}/accept-column`, { store, key }),
}
