import { oneTimeTokensRepo } from "./oneTimeTokens.js";

export const emailVerificationsRepo = (db) => oneTimeTokensRepo(db.collection("emailVerifications"));
