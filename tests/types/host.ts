import { Context } from '@deepseek-ai/cordis'
import { Config, apply, type InteractiveTerminalService } from 'dsh-interactive-terminal'
import { apply as installInvariant } from 'dsh-interactive-terminal/invariant'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

const ctx = new Context()
const service: InteractiveTerminalService = ctx.interactiveTerminals
const connection: HostConnectionHandle = ctx.connection
void [service, connection, installInvariant, apply, Config]
