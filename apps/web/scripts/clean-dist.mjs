/** Remove apps/web/dist before a production vite build.
 *
 * Concurrent orphaned `vite build --watch --no-emptyOutDir` processes otherwise
 * race vite's emptyOutDir (ENOTEMPTY) and can delete brand-font license assets
 * mid-write (ENOENT on Montserrat-OFL.txt). A forced recursive delete up front
 * makes one-shot `pnpm run build:web` deterministic even when a watcher left
 * partial trees behind; watch mode keeps --no-emptyOutDir and skips this script.
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
rmSync(dist, { recursive: true, force: true })
