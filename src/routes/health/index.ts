import type { FastifyPluginAsync } from "fastify";
import { Type } from "typebox";

const health: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    {
      schema: {
        summary: "Check database readiness",
        response: { 200: Type.Object({ status: Type.Literal("ok") }) },
      },
    },
    async () => {
      await fastify.mongo.db!.command({ ping: 1 });
      return { status: "ok" };
    },
  );
};
export default health;
