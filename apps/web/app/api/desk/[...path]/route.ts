// The desk, mounted. Every verb lands in the one dispatcher, which is where the route order — and
// therefore the access-control argument — lives.
//
// Node, not edge: the pool reads use viem against three RPCs and the store is a libSQL client.
// Force-dynamic because every answer here depends on a session cookie; a cached one would be
// another manager's book.
import { handle } from "@/src/desk/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
