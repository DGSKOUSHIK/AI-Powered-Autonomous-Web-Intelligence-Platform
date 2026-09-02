import { MongoClient, type Collection, type ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = process.env.MONGODB_DB || "webintel";

let clientPromise: Promise<MongoClient> | null = null;

function getClient(): Promise<MongoClient> {
  if (!clientPromise) {
    clientPromise = MongoClient.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    }).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

function getDb() {
  return getClient().then((c) => c.db(DB_NAME));
}

/* ---------- Types ---------- */

export interface UserDoc {
  _id: ObjectId | string;
  username: string;
  passwordHash: string;
  createdAt: Date;
}

export interface SessionTokenDoc {
  _id: ObjectId | string;
  token: string;
  userId: ObjectId | string;
  createdAt: Date;
  expiresAt: Date;
}

export interface JobDoc {
  title: string;
  url?: string;
  company?: string;
  location?: string;
  locationString?: string;
  datePosted?: string;
  employmentType?: string;
  jobId?: string;
  salary?: string;
  source: string;
}

export interface AgentRunDoc {
  url: string;
  requirement: string;
  answer: string;
  jobs: JobDoc[];
  crawl: {
    pages: number;
    contentLength: number;
    crawledUrls: { url: string; title: string; depth: number; status: string }[];
    picks: { parent: string; picked: string[]; reason: string }[];
  };
  title: string;
  durationMs: number;
  createdAt: Date;
}

export interface SessionDoc {
  _id: ObjectId | string;
  userId?: ObjectId | string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: MessageDoc[];
}

export interface MessageDoc {
  id: string;
  role: "user" | "agent";
  url?: string;
  requirement?: string;
  answer?: string;
  jobs?: JobDoc[];
  crawl?: AgentRunDoc["crawl"];
  title?: string;
  pages?: number;
  durationMs?: number;
  error?: string;
  createdAt: Date;
}

/* ---------- Collections ---------- */

async function usersCol(): Promise<Collection<UserDoc>> {
  const db = await getDb();
  const col = db.collection<UserDoc>("users");
  await col.createIndex({ username: 1 }, { unique: true });
  return col;
}

async function tokensCol(): Promise<Collection<SessionTokenDoc>> {
  const db = await getDb();
  const col = db.collection<SessionTokenDoc>("auth_tokens");
  await col.createIndex({ token: 1 }, { unique: true });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return col;
}

async function sessionsCol(): Promise<Collection<SessionDoc>> {
  const db = await getDb();
  const col = db.collection<SessionDoc>("sessions");
  await col.createIndex({ updatedAt: -1 });
  await col.createIndex({ userId: 1, updatedAt: -1 });
  return col;
}

/* ---------- Auth helpers ---------- */

const TOKEN_COOKIE = "webintel_auth";
const TOKEN_BYTES = 32;
const SESSION_DAYS = 30;

function randomToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createUser(
  username: string,
  password: string,
): Promise<{ id: string; username: string }> {
  const col = await usersCol();
  const clean = username.trim().toLowerCase();
  if (clean.length < 3) throw new Error("Username must be at least 3 characters");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");

  const existing = await col.findOne({ username: clean });
  if (existing) throw new Error("Username already taken");

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const res = await col.insertOne({
    username: clean,
    passwordHash,
    createdAt: now,
  } as Omit<UserDoc, "_id"> as unknown as UserDoc);

  return { id: res.insertedId.toString(), username: clean };
}

export async function verifyUser(
  username: string,
  password: string,
): Promise<{ id: string; username: string } | null> {
  const col = await usersCol();
  const clean = username.trim().toLowerCase();
  const user = await col.findOne({ username: clean });
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;
  return { id: user._id.toString(), username: user.username };
}

export async function createAuthToken(userId: string): Promise<string> {
  const col = await tokensCol();
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const { ObjectId } = await import("mongodb");
  await col.insertOne({
    token,
    userId: new ObjectId(userId) as unknown as SessionTokenDoc["userId"],
    createdAt: now,
    expiresAt: expires,
  } as Omit<SessionTokenDoc, "_id"> as unknown as SessionTokenDoc);
  return token;
}

export async function destroySession(token: string): Promise<void> {
  const col = await tokensCol();
  await col.deleteOne({ token });
}

export async function getUserFromToken(
  token: string | undefined | null,
): Promise<{ id: string; username: string } | null> {
  if (!token) return null;
  const col = await tokensCol();
  const doc = await col.findOne({ token });
  if (!doc) return null;
  if (doc.expiresAt < new Date()) {
    await col.deleteOne({ token });
    return null;
  }
  const ucol = await usersCol();
  const { ObjectId } = await import("mongodb");
  const user = await ucol.findOne({
    _id: new ObjectId(doc.userId as string) as unknown as UserDoc["_id"],
  });
  if (!user) return null;
  return { id: user._id.toString(), username: user.username };
}

export async function setAuthCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearAuthCookie(): Promise<void> {
  const store = await cookies();
  store.delete(TOKEN_COOKIE);
}

export async function getAuthToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(TOKEN_COOKIE)?.value;
}

export async function getCurrentUser(): Promise<{
  id: string;
  username: string;
} | null> {
  const token = await getAuthToken();
  return getUserFromToken(token);
}

/* ---------- Session API (user-scoped) ---------- */

export async function createSession(
  userId: string,
  title = "New analysis",
): Promise<string> {
  const col = await sessionsCol();
  const { ObjectId } = await import("mongodb");
  const now = new Date();
  const res = await col.insertOne({
    userId: new ObjectId(userId) as unknown as SessionDoc["userId"],
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  } as Omit<SessionDoc, "_id"> as unknown as SessionDoc);
  return res.insertedId.toString();
}

export async function listSessions(
  userId: string,
  limit = 50,
): Promise<
  { _id: string; title: string; updatedAt: Date; messageCount: number }[]
> {
  const col = await sessionsCol();
  const { ObjectId } = await import("mongodb");
  const cur = col
    .find(
      { userId: new ObjectId(userId) as unknown as SessionDoc["userId"] },
      { projection: { _id: 1, title: 1, updatedAt: 1, messages: 1 } },
    )
    .sort({ updatedAt: -1 })
    .limit(limit);
  const docs = await cur.toArray();
  return docs.map((d) => ({
    _id: d._id.toString(),
    title: d.title,
    updatedAt: d.updatedAt,
    messageCount: d.messages?.length ?? 0,
  }));
}

export async function getSession(
  id: string,
  userId: string,
): Promise<SessionDoc | null> {
  const col = await sessionsCol();
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(id)) return null;
  return col.findOne({
    _id: new ObjectId(id) as unknown as SessionDoc["_id"],
    userId: new ObjectId(userId) as unknown as SessionDoc["userId"],
  });
}

export async function appendMessage(
  sessionId: string,
  message: MessageDoc,
  title?: string,
): Promise<void> {
  const col = await sessionsCol();
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(sessionId)) return;
  const setFields: Record<string, unknown> = { updatedAt: new Date() };
  if (title) setFields.title = title;
  await col.updateOne(
    { _id: new ObjectId(sessionId) as unknown as SessionDoc["_id"] },
    { $push: { messages: message }, $set: setFields },
  );
}

export async function appendUserMessage(
  sessionId: string,
  message: { id: string; url: string; requirement: string; createdAt: Date },
  title?: string,
): Promise<void> {
  const msg: MessageDoc = {
    id: message.id,
    role: "user",
    url: message.url,
    requirement: message.requirement,
    createdAt: message.createdAt,
  };
  await appendMessage(sessionId, msg, title);
}

export async function deleteSession(
  id: string,
  userId: string,
): Promise<void> {
  const col = await sessionsCol();
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(id)) return;
  await col.deleteOne({
    _id: new ObjectId(id) as unknown as SessionDoc["_id"],
    userId: new ObjectId(userId) as unknown as SessionDoc["userId"],
  });
}

export async function renameSession(
  id: string,
  userId: string,
  title: string,
): Promise<void> {
  const col = await sessionsCol();
  const { ObjectId } = await import("mongodb");
  if (!ObjectId.isValid(id)) return;
  await col.updateOne(
    {
      _id: new ObjectId(id) as unknown as SessionDoc["_id"],
      userId: new ObjectId(userId) as unknown as SessionDoc["userId"],
    },
    { $set: { title, updatedAt: new Date() } },
  );
}

export async function pingDb(): Promise<boolean> {
  try {
    const client = await getClient();
    await client.db(DB_NAME).command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}