// Plain `tsc` (CI's "Check web imports resolve" step) can't resolve .astro files;
// Vite and `astro check` can. This fallback only applies when a .astro import
// isn't otherwise resolved, so `astro check` still sees the real component types.
// Needed by tests that render components with the Container API (SeoHead.astro.test.ts).
declare module "*.astro" {
  const component: any
  export default component
}
