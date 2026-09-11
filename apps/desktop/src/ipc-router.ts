import { AppCommands, AppOutputSchemas, DesktopCommands, DesktopOutputSchemas, ErrorSchema, KuroError, failure, success } from '@kuro/contracts';
import type { AppCommandName, AppPort, DesktopHostPort, Result } from '@kuro/contracts';

export interface Sender { id: number; isMainFrame: boolean; url: string }
export interface WindowBinding { senderId: number; url: string; app: AppPort; host: DesktopHostPort }
export function trustedSender(sender: Sender, binding: WindowBinding): boolean {
  return sender.id === binding.senderId && sender.isMainFrame && sender.url === binding.url;
}
/** Exhaustive fixed registration happens in main; no user-selected dispatcher is exposed. */
export async function routeCall(binding: WindowBinding, sender: Sender, surface: 'app' | 'host', name: string, input: unknown): Promise<Result<unknown>> {
  if (!trustedSender(sender, binding)) return failure('ACCESS_DENIED');
  try {
    if (surface === 'app') {
      if (!Object.hasOwn(AppCommands, name)) return failure('INVALID_INPUT');
      const key = name as AppCommandName;
      const parsed = AppCommands[key].safeParse(input);
      if (!parsed.success) return failure('INVALID_INPUT');
      // Correlated input/output union is validated before and after the bound call.
      const command = binding.app[key] as (value: unknown) => Promise<Result<unknown>>;
      const result = await command(parsed.data);
      return result.ok ? success(AppOutputSchemas[key].parse(result.value)) : { ok: false, error: ErrorSchema.parse(result.error) };
    }
    if (!Object.hasOwn(DesktopCommands, name)) return failure('INVALID_INPUT');
    const key = name as keyof DesktopHostPort;
    const parsed = DesktopCommands[key].safeParse(input);
    if (!parsed.success) return failure('INVALID_INPUT');
    const command = binding.host[key] as (value: unknown) => Promise<Result<unknown>>;
    const result = await command(parsed.data);
    return result.ok ? success(DesktopOutputSchemas[key].parse(result.value)) : { ok: false, error: ErrorSchema.parse(result.error) };
  } catch (error) { return failure(error instanceof KuroError ? error.code : 'STORAGE_FAILURE'); }
}
