import http from 'node:http';

// Reads containers' memory straight from the Docker Engine API over its unix socket: a one-shot stats
// call answers in ~40 ms, where `docker stats --no-stream` waits ~2 s for a CPU delta it would throw
// away here.

export interface ContainerMemoryStats {
  usage?: number;
  stats?: Record<string, number>;
}

/**
 * A container's memory as `docker stats` shows it: usage minus the inactive page cache
 * (`calculateMemUsageUnixNoCache` in docker/cli) — `total_inactive_file` on cgroup v1,
 * `inactive_file` on v2.
 */
export function containerMemory(mem: ContainerMemoryStats): number {
  const usage = mem.usage ?? 0;
  const v1 = mem.stats?.total_inactive_file;
  if (v1 !== undefined && v1 < usage) {
    return usage - v1;
  }
  const v2 = mem.stats?.inactive_file ?? 0;
  return v2 < usage ? usage - v2 : usage;
}

/** The socket path in a Docker endpoint (`unix:///…`), or null for any other kind (tcp, ssh). */
export function socketPath(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  return trimmed.startsWith('unix://') ? trimmed.slice('unix://'.length) : null;
}

function getJson<T>(socket: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: socket, path, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`Docker API ${path}: ${String(res.statusCode)}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          reject(err as Error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker API ${path}: timed out`)));
    req.on('error', reject);
  });
}

interface ContainerSummary {
  Id: string;
  Labels?: Record<string, string>;
}

/**
 * Memory per Compose service of `project`, summed over its running containers (a scaled service has
 * several).
 */
export async function composeMemory(socket: string, project: string): Promise<Map<string, number>> {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=${project}`], status: ['running'] }),
  );
  const containers = await getJson<ContainerSummary[]>(
    socket,
    `/containers/json?filters=${filters}`,
  );
  const readings = await Promise.all(
    containers.map(async (c) => {
      const service = c.Labels?.['com.docker.compose.service'];
      if (!service) {
        return null;
      }
      const stats = await getJson<{ memory_stats?: ContainerMemoryStats }>(
        socket,
        `/containers/${c.Id}/stats?stream=false&one-shot=true`,
      ).catch(() => null); // gone meanwhile
      return stats?.memory_stats ? ([service, containerMemory(stats.memory_stats)] as const) : null;
    }),
  );
  const out = new Map<string, number>();
  for (const reading of readings) {
    if (reading) {
      out.set(reading[0], (out.get(reading[0]) ?? 0) + reading[1]);
    }
  }
  return out;
}
