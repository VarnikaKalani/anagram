import { fail, ok } from "../../_utils";
import { leaveRoomSession } from "../../../../server/room-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { code?: string; playerId?: string };
    const result = await leaveRoomSession(body.code ?? "", body.playerId ?? "");
    if (result.error) {
      return fail(result.error.errorCode, result.error.message, 400);
    }
    return ok(result.data);
  } catch {
    return fail("UNKNOWN", "Could not leave room.", 500);
  }
}
