/**
 * Which page this is. The window's top page is the TAB HOST (src/tabs/host.ts):
 * it holds one iframe per open document, each of which boots the editor
 * (bootApp.ts) on `/?frame=<id>`. `?single` boots the editor directly in the
 * top page, with no tabs — what the test drivers use, since they reach into
 * the page's stores and engine.
 */
const single = new URLSearchParams(location.search).has('single')

/**
 * A deployed page checks it is the CURRENT build before booting. Some cache
 * on the way (browser, proxy, CDN edge) kept serving the previous index.html
 * after a deploy, and only Ctrl+Shift+R showed the new version. The bundle
 * knows its own build (`__BUILD_ID__`); `version.json` is fetched uncached,
 * and a page that disagrees reloads ONCE with a parameter no cache has seen.
 * Not in development, and not in the Windows app (app://, files on disk).
 */
async function ensureCurrentBuild(): Promise<boolean> {
  const url = new URL(location.href)
  if (url.searchParams.has('_v')) {
    url.searchParams.delete('_v')
    history.replaceState(history.state, '', url.toString())
  }
  if (!import.meta.env.PROD || !/^https?:$/.test(location.protocol)) return true
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 2000)
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store', signal: ctl.signal })
    clearTimeout(timer)
    if (!res.ok) return true
    const { build } = await res.json()
    if (!build || build === __BUILD_ID__) return true
    // Per page: a window's tab frames share its sessionStorage, and the host
    // reloading first must not stop a stale frame from reloading too.
    const key = `pdfedit.reloadedFor:${url.searchParams.get('frame') ?? (single ? 'single' : 'top')}`
    if (sessionStorage.getItem(key) === build) return true // tried once already: never loop
    sessionStorage.setItem(key, build)
    url.searchParams.set('_v', build)
    location.replace(url.toString())
    return false
  } catch {
    return true // offline, or slow: run what we have
  }
}

ensureCurrentBuild().then(current => {
  if (!current) return
  if (window.top === window && !single) import('./tabs/host')
  else import('./bootApp')
})
