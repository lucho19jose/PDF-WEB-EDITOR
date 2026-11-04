/**
 * Which page this is. The window's top page is the TAB HOST (src/tabs/host.ts):
 * it holds one iframe per open document, each of which boots the editor
 * (bootApp.ts) on `/?frame=<id>`. `?single` boots the editor directly in the
 * top page, with no tabs — what the test drivers use, since they reach into
 * the page's stores and engine.
 */
const single = new URLSearchParams(location.search).has('single')

if (window.top === window && !single) {
  import('./tabs/host')
} else {
  import('./bootApp')
}
