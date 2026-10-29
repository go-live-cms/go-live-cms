import { useCallback, useMemo } from "react"
import { dismissToast, toast, type ToastType } from "@gl-admin/components/ui/Toast"

// The pre-redesign toast API, kept so the screens using it keep working until
// #339–#344 move them to `toast` from components/ui/Toast (#338). Both now draw
// through the one <Toaster /> in app.tsx; ToastContainer renders nothing.

export interface ToastMessage {
  id: string
  type: ToastType
  message: string
  duration?: number
}

// The app-wide <Toaster /> draws toasts now; this renders nothing.
export function ToastContainer(_props: { toasts: ToastMessage[]; onRemoveToast: (id: string) => void }) {
  return null
}

// New code uses `toast` from components/ui/Toast.
export const useToast = () => {
  const showToast = useCallback(
    // The old API treated 0 as "the default" (`duration || 3000`), not "hide at once".
    (type: ToastType, message: string, duration?: number) => toast[type](message, { duration: duration || undefined }),
    []
  )

  return useMemo(
    () => ({
      toasts: [] as ToastMessage[],
      showToast,
      showSuccess: (message: string, duration?: number) => showToast("success", message, duration),
      showError: (message: string, duration?: number) => showToast("error", message, duration),
      showWarning: (message: string, duration?: number) => showToast("warning", message, duration),
      showInfo: (message: string, duration?: number) => showToast("info", message, duration),
      removeToast: dismissToast,
    }),
    [showToast]
  )
}
