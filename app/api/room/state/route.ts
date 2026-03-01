import { fail, getErrorMessage, ok } from "../../_utils";
import { getRoomStateSession } from "../../../../server/room-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code") ?? "";
    const playerId = searchParams.get("playerId") ?? "";
    const reconnectToken = searchParams.get("reconnectToken") ?? undefined;

    const result = await getRoomStateSession(code, playerId, reconnectToken);
    if (result.error) {
      return fail(result.error.errorCode, result.error.message, 400);
    }
    return ok(result.data);
  } catch (error) {
    return fail("UNKNOWN", getErrorMessage(error, "Could not fetch room state."), 500);
  }
}
