import { oneTimeTokensRepo } from "./oneTimeTokens.js";

export { hashToken } from "./oneTimeTokens.js";

export const passwordResetsRepo = (db) => oneTimeTokensRepo(db.collection("passwordResets"));
