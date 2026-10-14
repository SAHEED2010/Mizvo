import { createAccessControl } from "better-auth/plugins/access";

export const businessStatement = {
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
} as const;

export const businessAccess = createAccessControl(businessStatement);

export const ownerRole = businessAccess.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

export const managerRole = businessAccess.newRole({});
export const staffRole = businessAccess.newRole({});
export const viewerRole = businessAccess.newRole({});

export const businessRoles = {
  owner: ownerRole,
  manager: managerRole,
  staff: staffRole,
  viewer: viewerRole,
};

export const businessPermissions = {
  owner: [
    "business:read",
    "business:update",
    "members:manage",
    "finance:read",
    "finance:write",
    "finance:correct",
    "reports:share",
  ],
  manager: ["business:read", "finance:read", "finance:write", "finance:correct"],
  staff: ["business:read", "finance:read-assigned", "finance:write-operational"],
  viewer: ["business:read", "finance:read"],
} as const;

export type BusinessRole = keyof typeof businessPermissions;
export type BusinessPermission = (typeof businessPermissions)[BusinessRole][number];

export function hasBusinessPermission(role: string, permission: BusinessPermission): boolean {
  return (
    isBusinessRole(role) &&
    (businessPermissions[role] as readonly BusinessPermission[]).includes(permission)
  );
}

export function isBusinessRole(role: string): role is BusinessRole {
  return role in businessPermissions;
}
