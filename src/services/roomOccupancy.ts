export type RoomTenantRecord = {
  id: string;
  floor?: unknown;
  room?: unknown;
  status?: unknown;
  deletedAt?: unknown;
};

export const LEGACY_ROOM_SYNC_ERROR =
  'This room is full or unavailable. Change the tenant assignment or increase room capacity before retrying.';
export const DUPLICATE_CLOUD_ROOM_SYNC_ERROR =
  'Multiple cloud rooms have the same floor and room labels.';

export type CloudRoomCandidate = {
  id: string;
  capacity: unknown;
  deletedAt?: unknown;
};

export function chooseCanonicalCloudRoom<T extends CloudRoomCandidate>(rooms: T[]) {
  if (rooms.length === 0) throw new Error('At least one cloud room is required.');
  return [...rooms].sort((a, b) => {
    const activeDifference = Number(Boolean(a.deletedAt)) - Number(Boolean(b.deletedAt));
    if (activeDifference !== 0) return activeDifference;
    const capacityDifference = Number(b.capacity) - Number(a.capacity);
    if (Number.isFinite(capacityDifference) && capacityDifference !== 0) return capacityDifference;
    return a.id.localeCompare(b.id);
  })[0];
}

export function reconcileRoomOccupants(
  storedOccupantIds: string[],
  observedOccupants: RoomTenantRecord[],
  floor: string,
  room: string,
) {
  const activeById = new Map(
    observedOccupants
      .filter((tenant) => tenant.status === 'Active'
        && !tenant.deletedAt
        && tenant.floor === floor
        && tenant.room === room)
      .map((tenant) => [tenant.id, tenant]),
  );
  const candidates = new Set([...storedOccupantIds, ...activeById.keys()]);
  return [...candidates].filter((tenantId) => activeById.has(tenantId));
}
