import { parseJsonBody } from '../middleware.mjs';

export function registerMetadataRoutes(router, ctx) {
  router.post('/api/metadata/jobs', async (req, _res, { respond }) => {
    const body = await parseJsonBody(req);
    try {
      const job = await ctx.metadataJobs.createJob({
        provider: body.provider,
        seriesIds: body.seriesIds,
        overwrite: body.overwrite,
        apply: body.apply,
      });
      respond(202, job);
    } catch (error) {
      if (/unknown metadata provider/i.test(error.message)) {
        respond(400, { error: error.message });
        return;
      }
      throw error;
    }
  });

  router.get('/api/metadata/jobs/:id', (_req, _res, { params, query, respond }) => {
    const page = Number.parseInt(query.page ?? '1', 10);
    const pageSize = Number.parseInt(query.pageSize ?? '50', 10);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      respond(400, { error: 'page must be >= 1 and pageSize must be between 1 and 200' });
      return;
    }
    const job = ctx.metadataJobs.getJob(params.id, { page, pageSize });
    if (!job) {
      respond(404, { error: 'Metadata job not found' });
      return;
    }
    respond(200, job);
  });

  router.delete('/api/metadata/jobs/:id', async (_req, _res, { params, respond }) => {
    const cancelled = await ctx.metadataJobs.cancelJob(params.id);
    if (!cancelled) {
      respond(404, { error: 'Active metadata job not found' });
      return;
    }
    respond(202, { jobId: params.id, status: 'cancelling' });
  });
}
