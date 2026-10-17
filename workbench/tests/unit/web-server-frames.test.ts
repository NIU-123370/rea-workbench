import { describe, expect, it } from "vitest";

import { writeStreamFrames } from "../../apps/web/server.ts";

// The frame loop is asserted on its own because the thing it guards is a race on a real socket: a
// stop that lands while a frame is already in the loop's hands. Issue #85's mutation round found
// that deleting the check left every gate green, which is what this file is for.

describe("the stream's frame loop (DESIGN §13, issue #85)", () => {
  it("writes every frame the pump hands out, in order, until it reports the close", async () => {
    const queued = ["id: 1\n\n", "id: 2\n\n", "id: 3\n\n"];
    const written: string[] = [];
    await writeStreamFrames({
      take: async () => queued.shift() ?? null,
      ended: () => false,
      write: (frame) => written.push(frame),
    });
    expect(written).toEqual(["id: 1\n\n", "id: 2\n\n", "id: 3\n\n"]);
  });

  it("does not write into a response the stop already finished", async () => {
    const queued = ["id: 1\n\n", "id: 2\n\n"];
    const written: string[] = [];
    let ended = false;
    await writeStreamFrames({
      take: async () => queued.shift() ?? null,
      ended: () => ended,
      // The stop is what happens right after the first write: the second frame has already been
      // taken off the pump, and taking it is not a licence to hand it to a finished response.
      write: (frame) => {
        written.push(frame);
        ended = true;
      },
    });
    expect(written).toEqual(["id: 1\n\n"]);
  });

  it("ends quietly when a read fails instead of rejecting the stop", async () => {
    const written: string[] = [];
    // A pump that throws is the socket disappearing mid-tail. The loop's answer is to stop: the
    // client re-reads a snapshot, and there is no status code left to send on a finished response.
    await writeStreamFrames({
      take: async () => {
        throw new Error("the worker's socket went away");
      },
      ended: () => false,
      write: (frame) => written.push(frame),
    });
    expect(written).toEqual([]);
  });
});
