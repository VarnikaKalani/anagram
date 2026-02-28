import { fail, getErrorMessage, ok } from "../../_utils";
import { createRoomSession } from "../../../../server/room-service";
import type { DifficultyMode } from "../../../../shared/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { name?: string; mode?: DifficultyMode };
    const result = await createRoomSession(body.name ?? "", body.mode);
    if (result.error) {
      return fail(result.error.errorCode, result.error.message, 400);
    }
    return ok(result.data);
  } catch (error) {
    return fail("UNKNOWN", getErrorMessage(error, "Could not create room."), 500);
  }
}
