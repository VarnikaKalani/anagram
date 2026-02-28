import { fail, ok } from "../../_utils";
import { submitWordSession } from "../../../../server/room-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { code?: string; playerId?: string; word?: string };
    const result = await submitWordSession(body.code ?? "", body.playerId ?? "", body.word ?? "");
    if (result.error) {
      return fail(result.error.errorCode, result.error.message, 400);
    }
    return ok(result.data);
  } catch {
    return fail("UNKNOWN", "Could not submit word.", 500);
  }
}
