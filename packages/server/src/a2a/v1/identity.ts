import type { OwnerResolver, User } from "@a2a-js/sdk/server";
import type { A2ACallerScope } from "../../routes/a2a/helpers.js";

/** Constructed only after getCallerScope has resolved the authenticated key. */
export class VerifiedA2AUser implements User {
  readonly isAuthenticated = true;
  readonly userName: string;
  readonly tenantId: string;

  constructor(scope: A2ACallerScope) {
    if (!scope.ownerId || !scope.tenantId) {
      throw new Error("A2A v1 requires a verified owner and tenant");
    }
    this.userName = scope.ownerId;
    this.tenantId = scope.tenantId;
  }
}

/** JSON tuple encoding prevents delimiter collisions between tenant and owner. */
export const dzupOwnerResolver: OwnerResolver = (context) => {
  const user = context.user;
  if (!(user instanceof VerifiedA2AUser) || context.tenant !== user.tenantId) {
    throw new Error("A2A v1 requires a verified caller scope");
  }
  return JSON.stringify([user.tenantId, user.userName]);
};
