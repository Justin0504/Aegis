'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName: orgName }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'signup failed')
      // Persist the freshly-minted API key for the next screen.
      sessionStorage.setItem('aegis.newkey', JSON.stringify(data))
      router.push('/welcome')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shell">
      <Link href="/" className="brand">AEGIS</Link>
      <h1>Create an org.</h1>
      <p className="lede">
        Free tier — 1 agent, 100 tool-call checks / month, 24-hour retention. No
        card required.
      </p>

      <form onSubmit={submit} className="card form-stack">
        <div>
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" autoComplete="email" required
                 value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="new-password" required
                 minLength={8} value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        <div>
          <label htmlFor="orgName">Org name</label>
          <input id="orgName" required minLength={2}
                 placeholder="Acme Inc."
                 value={orgName} onChange={e => setOrgName(e.target.value)} />
        </div>

        {error && <div className="error">{error}</div>}

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create org & continue'}
        </button>
      </form>

      <p className="meta">
        Already have one? <Link href="/login">Sign in</Link>
      </p>
    </div>
  )
}
