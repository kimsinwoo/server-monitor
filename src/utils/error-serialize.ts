/** nodemailer / SMTP 등에서 원인 파악용으로 unknown 에러를 문자열화 */
export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    const parts = [`${err.name}: ${err.message}`];
    const any = err as Error & {
      code?: string;
      command?: string;
      responseCode?: number | string;
      response?: string;
    };
    if (any.code != null) parts.push(`code=${String(any.code)}`);
    if (any.command != null) parts.push(`command=${String(any.command)}`);
    if (any.responseCode != null) parts.push(`responseCode=${String(any.responseCode)}`);
    if (any.response != null) parts.push(`response=${String(any.response)}`);
    if (err.stack) parts.push(err.stack);
    return parts.join('\n');
  }
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
