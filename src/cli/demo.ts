import type { LinearClient } from "../linear/client";
import type { Runner } from "../runner/types";
import { FakeRunner } from "../testing/fakeRunner";
import { FakeLinearClient } from "../testing/fakes/fakeLinearClient";

export function isDemoTracker(kind: string | undefined): boolean {
  return kind?.toLowerCase() === "demo";
}

export function createDemoLinearClient(): LinearClient {
  const client = new FakeLinearClient();

  // Seed a couple of in-memory issues so the visual CLI has something to show.
  client.upsertIssue({
    id: "demo-1",
    identifier: "RIC-6",
    title: "Add visual CLI",
    state: "Todo",
  });
  client.upsertIssue({
    id: "demo-2",
    identifier: "RIC-7",
    title: "Follow-up",
    state: "In Progress",
  });

  return client as unknown as LinearClient;
}

export function createDemoRunner(): Runner {
  // First dispatch fails (shows retry queue), second hangs (shows running).
  return new FakeRunner([{ kind: "fail", code: 1 }, { kind: "hang" }]);
}
