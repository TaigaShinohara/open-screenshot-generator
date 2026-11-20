import type { McpConnectionConfig } from './desktopMcpServer';

export type NativeMcpClient = 'claude-code' | 'claude-desktop' | 'vscode' | 'cursor';

export function nativeClientConfig(client: NativeMcpClient, connection: McpConnectionConfig): string {
  const { url, headers, headerFile } = connection;
  const name = 'tiger-screen-shot';
  const server = client === 'claude-desktop'
    ? { command: 'npx', args: ['-y', 'mcp-remote@latest', url, '--allow-http', '--header-file', headerFile] }
    : { ...(client === 'cursor' ? {} : { type: 'http' }), url, headers };
  return JSON.stringify({ [client === 'vscode' ? 'servers' : 'mcpServers']: { [name]: server } }, null, 2);
}
