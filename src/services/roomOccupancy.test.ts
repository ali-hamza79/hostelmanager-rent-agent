import { describe, expect, it } from 'vitest';
import { chooseCanonicalCloudRoom, reconcileRoomOccupants } from './roomOccupancy';

describe('reconcileRoomOccupants', () => {
  it('removes stale IDs and counts only active tenants currently assigned to the room', () => {
    const occupants = reconcileRoomOccupants(
      ['current-tenant', 'deleted-tenant', 'moved-tenant', 'missing-tenant'],
      [
        { id: 'current-tenant', floor: '1', room: 'A-1', status: 'Active' },
        { id: 'deleted-tenant', floor: '1', room: 'A-1', status: 'Active', deletedAt: '2026-11-01T00:00:00.000Z' },
        { id: 'moved-tenant', floor: '1', room: 'B-1', status: 'Active' },
        { id: 'inactive-tenant', floor: '1', room: 'A-1', status: 'Inactive' },
      ],
      '1',
      'A-1',
    );

    expect(occupants).toEqual(['current-tenant']);
  });

  describe('chooseCanonicalCloudRoom', () => {
    it('chooses the highest-capacity duplicate and breaks ties by ID', () => {
      const selected = chooseCanonicalCloudRoom([
        { id: 'deleted-largest', capacity: 9, deletedAt: '2026-11-04T00:00:00.000Z' },
        { id: 'legacy-room-z', capacity: 4 },
        { id: 'legacy-room-a', capacity: 4 },
        { id: 'small-room', capacity: 2 },
      ]);

      expect(selected.id).toBe('legacy-room-a');
    });
  });

  it('includes active room tenants that are missing from the stored occupancy list', () => {
    const occupants = reconcileRoomOccupants(
      [],
      [
        { id: 'active-tenant', floor: '2', room: 'C-2', status: 'Active' },
        { id: 'other-room-tenant', floor: '2', room: 'C-3', status: 'Active' },
      ],
      '2',
      'C-2',
    );

    expect(occupants).toEqual(['active-tenant']);
  });
});
