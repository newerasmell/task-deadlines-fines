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
  template?: boolean // an accepted store profile: products are built by its pattern
  access?: string | null // what stops an upload to this store (domain or Shopify access); null = can publish
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
  access_set: AccessInfo | null
  profile_accepted: boolean
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
  access_set: AccessInfo | null
  access: string | null
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

export type AuditIssue = {
  rule: string
  label: string
  status: Status
  action: string
  fields: number
  products: number
}

export type AuditSummary = {
  batch_id: number
  name: string
  group: string
  store: string | null
  created_at: string
  products: number
  issues: AuditIssue[]
  fix_products: number
  fix_fields: number
}

export type AuditItem = {
  product_id: number
  title: string
  field_id: number
  key: string
  value: unknown
  previous: unknown
  status: Status
  message: string
  price: string | null
  compare_at: string | null
  decided_by: string | null
}

export type GroupInfo = {
  key: string
  name: string
  ready: boolean
  stores: { key: string; label: string; country: string | null; language: string | null; currency: string | null }[]
}

export type CheckedRow = {
  line: number
  name: string
  ml: number | null
  tester: boolean
  ean: string
  prices: Record<string, string | null>
  tier: string | null
  problems: string[]
}

export type CheckResult = {
  rows: CheckedRow[]
  ready: number
  api_key: boolean
  estimate: {
    products: number
    stores: number
    languages: string[]
    total: number
    tiers: { tier: string; label: string; products: number; per_product: number; limit: number; ceiling: number; measured: boolean }[]
  }
}

export type Job = {
  id: string
  running: boolean
  stage: string
  stage_label: string
  done: number
  total: number
  error: string | null
  batch_id: number | null
  cost_usd: number | null
  fast?: boolean
  started_at?: number // unix seconds
  finished_at?: number | null
}

export type AccessInfo = { kind: 'client' | 'token'; updated_by: string | null; updated_at: string | null }

export type User = { id: number; name: string; is_admin: boolean; disabled: boolean }

/** Any 401 means the session ended: the login screen takes over (lib/auth.tsx listens). */
export const AUTH_EVENT = 'perfume-import:auth-required'

function sessionEnded(response: Response) {
  if (response.status === 401 && !response.url.includes('/api/auth/')) window.dispatchEvent(new Event(AUTH_EVENT))
}

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError('Няма връзка с API-то. Провери, че сървърът работи, и опитай отново.')
  }
  if (!response.ok) {
    sessionEnded(response)
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
    response = await fetch(path, { method: 'POST', body: form })
  } catch {
    throw new ApiError('Няма връзка с API-то. Провери, че сървърът работи, и опитай отново.')
  }
  if (!response.ok) {
    sessionEnded(response)
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

const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })

const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })

export const api = {
  me: () => request<{ user: User | null; setup_needed: boolean }>('/api/auth/me'),
  login: (name: string, password: string) => post<{ user: User }>('/api/auth/login', { name, password }),
  setup: (name: string, password: string) => post<{ user: User }>('/api/auth/setup', { name, password }),
  logout: () => post<{ ok: boolean }>('/api/auth/logout', {}),
  changePassword: (current: string, next: string) => post<User>('/api/auth/password', { current, new: next }),
  users: () => request<User[]>('/api/auth/users'),
  createUser: (name: string, password: string, is_admin: boolean) =>
    post<User>('/api/auth/users', { name, password, is_admin }),
  updateUser: (id: number, change: { password?: string; is_admin?: boolean; disabled?: boolean }) =>
    patch<User>(`/api/auth/users/${id}`, change),
  setAccess: (store: string, access: { client_id?: string; client_secret?: string; token?: string }) =>
    put<AccessInfo>(`/api/stores/${store}/access`, access),
  clearAccess: (store: string) => del<{ ok: boolean }>(`/api/stores/${store}/access`),
  checkAccess: (store: string) => post<{ ok: boolean; message: string }>(`/api/stores/${store}/access/check`, {}),
  batches: () => request<BatchSummary[]>('/api/batches'),
  batch: (id: number) => request<Batch>(`/api/batches/${id}`),
  product: (id: number) => request<Product & { batch_id: number }>(`/api/products/${id}`),
  vocab: (group: string) => request<Record<string, string[]>>(`/api/groups/${group}/vocab`),
  decide: (fieldId: number, action: 'accept' | 'edit' | 'pick', value?: unknown) =>
    post<Product>(`/api/fields/${fieldId}/decision`, { action, value }),
  acceptAll: (productId: number, store?: string) => post<Product>(`/api/products/${productId}/accept-all`, { store }),
  approve: (productId: number) => post<Product>(`/api/products/${productId}/approve`, {}),
  stores: () => request<StoreRow[]>('/api/stores'),
  groups: () => request<GroupInfo[]>('/api/groups'),
  checkBatch: (form: FormData) => upload<CheckResult>('/api/batches/check', form),
  startBatch: (form: FormData) => upload<{ job_id: string }>('/api/batches/start', form),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  latestJob: () => request<Job | null>('/api/jobs/latest'),
  audit: (batchId: number) => request<AuditSummary>(`/api/batches/${batchId}/audit`),
  auditItems: (batchId: number, rule: string, limit: number) =>
    request<{ rule: string; label: string; total: number; items: AuditItem[] }>(
      `/api/batches/${batchId}/audit/${encodeURIComponent(rule)}?limit=${limit}`,
    ),
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
