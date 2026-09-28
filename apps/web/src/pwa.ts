type ServiceWorkerRegistrar = Pick<ServiceWorkerContainer, 'register'>

export type PwaRegistrationEnvironment = {
  production?: boolean
  serviceWorker?: ServiceWorkerRegistrar | undefined
}

export function registerServiceWorker(environment: PwaRegistrationEnvironment = {}) {
  const production = environment.production ?? import.meta.env.PROD
  const serviceWorker = environment.serviceWorker ?? (
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined
  )

  if (!production || !serviceWorker) return undefined
  return serviceWorker.register('/sw.js', { scope: '/' })
}
