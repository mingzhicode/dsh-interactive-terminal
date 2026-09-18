import { Context } from '@deepseek-ai/cordis'
import { apply } from 'dsh-interactive-terminal/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

const ctx = new Context()
const connection: ConnectionHandle = ctx.connection
void connection
apply(ctx)
