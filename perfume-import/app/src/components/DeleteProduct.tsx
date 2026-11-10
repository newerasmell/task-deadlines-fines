import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api, type Batch, type Product } from '../lib/api'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'

/** „Изтрий“: a product prepared here and in no store yet (the API refuses anything else and says why). */
export function DeleteProduct({ batch, product }: { batch: Batch; product: Product }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sent = Object.values(product.stores).some((s) => s.upload_status === 'uploaded')
  if (batch.kind !== 'new' || sent) return null

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.deleteProduct(product.id)
      for (const key of [['batch'], ['batches'], ['catalog'], ['product-catalog'], ['send']])
        void client.invalidateQueries({ queryKey: key })
      const next = batch.products.find((p) => p.id !== product.id)
      navigate(r.batch_deleted || !next ? '/' : `/batches/${batch.id}/products/${next.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="ghost" size="lg" onClick={() => setOpen(true)}>
        Изтрий
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Изтрий продукта"
        description={`„${product.title}“ се изтрива от приложението с всичките му магазини (${Object.keys(product.stores).join(', ')}). Не е качван никъде, така че в Shopify нищо не се променя. Не може да се върне.`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Откажи</Button>
            <Button
              variant="primary"
              className="bg-blocked hover:bg-blocked-text"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Изтривам…' : 'Изтрий продукта'}
            </Button>
          </>
        }
      >
        {error && <span className="text-sm text-blocked-text">{error}</span>}
      </Dialog>
    </>
  )
}
