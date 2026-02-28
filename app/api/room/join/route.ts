import { fail, getErrorMessage, ok } from "../../_utils";
import { joinRoomSession } from "../../../../server/room-service";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { code?: string; name?: string; reconnectToken?: string };
    const result = await joinRoomSession(body.code ?? "", body.name ?? "", body.reconnectToken);
    if (result.error) {
      return fail(result.error.errorCode, result.error.message, 400);
    }
    return ok(result.data);
  } catch (error) {
    return fail("UNKNOWN", getErrorMessage(error, "Could not join room."), 500);
  }
}
