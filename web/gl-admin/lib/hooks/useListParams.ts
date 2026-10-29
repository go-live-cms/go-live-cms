import { useSearchParams } from "react-router-dom"

// A list's view state in the URL (?view=draft, ?sort=title, ?layout=list), so it survives
// a reload and can be linked to. Setting a key to its default removes it; history is
// replaced, not pushed.
export function useListParams(): [URLSearchParams, (key: string, value: string, fallback: string) => void] {
  const [params, setParams] = useSearchParams()
  const set = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params)
    if (value === fallback) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }
  return [params, set]
}
