import { useEffect, useState } from 'react'

type Health = { status: string; db: string }

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setError('API-то не отговаря. Стартирай го с „make api“ и презареди.'))
  }, [])

  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>Импорт на парфюми</h1>
      <p style={{ color: 'var(--ink-2)', margin: 0 }}>
        {error ?? (health ? `API: ${health.status} · база: ${health.db}` : 'Проверявам връзката с API…')}
      </p>
    </main>
  )
}
