/** Browser-only service face; Host and browser compile as separate programs. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
declare module '@deepseek-ai/cordis' {
  interface Context { connection: ConnectionHandle }
}
