import { Navigate, useParams } from 'react-router'
import { Empty, Failure, Loading } from '../components/States'
import { useBatch } from '../lib/queries'

/** Opening a batch lands on the first product that still needs a person (or the first one). */
export function BatchEntry() {
  const batchId = Number(useParams().batchId)
  const batch = useBatch(batchId)
  if (batch.isPending) return <Loading what="партидата" />
  if (batch.isError) return <Failure error={batch.error} retry={() => batch.refetch()} />
  if (batch.data.kind === 'audit') return <Navigate replace to={`/batches/${batchId}/grid`} />
  const first = batch.data.products.find((p) => p.state !== 'ready') ?? batch.data.products[0]
  if (!first) return <Empty>Партидата няма продукти.</Empty>
  return <Navigate replace to={`/batches/${batchId}/products/${first.id}`} />
}
