import Fastify, { type FastifyInstance } from 'fastify';
import { HTTP_HEADERS } from '../contracts/index.ts';
import { drainTelemetry, initTelemetry } from '../telemetry/index.ts';
import { FaultController, faultRequestSchema } from './faults.ts';
import { checkFaultGate } from './faultGate.ts';

export interface ServiceKit {
  app: FastifyInstance;
  faults: FaultController;
  listen(port: number): Promise<void>;
}

export function createService(name: string): ServiceKit {
  initTelemetry({ service: name });
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const faults = new FaultController();

  app.get('/healthz', async () => ({ ok: true, service: name }));

  const gate = (req: { headers: Record<string, unknown>; ip: string }) =>
    checkFaultGate(process.env, { token: req.headers[HTTP_HEADERS.faultToken] as string | undefined, remoteAddress: req.ip });

  app.get('/internal/faults', async (req, reply) => {
    const g = gate(req);
    if (!g.allowed) return reply.code(g.status).send({ error: g.reason });
    return { service: name, faults: faults.list() };
  });

  app.post('/internal/faults', async (req, reply) => {
    const g = gate(req);
    if (!g.allowed) return reply.code(g.status).send({ error: g.reason });
    const parsed = faultRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid fault request', issues: parsed.error.issues });
    faults.set(parsed.data.faults, parsed.data.ttlSeconds, parsed.data.experimentId);
    return { service: name, faults: faults.list() };
  });

  app.delete('/internal/faults', async (req, reply) => {
    const g = gate(req);
    if (!g.allowed) return reply.code(g.status).send({ error: g.reason });
    faults.clear();
    return { service: name, faults: [] };
  });

  const shutdown = async () => {
    await drainTelemetry(1500);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    app,
    faults,
    listen: async (port) => {
      await app.listen({ port, host: '127.0.0.1' });
    },
  };
}
