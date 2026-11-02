import { create } from 'zustand';
import { RouteName, HostelMeta } from '../types';

interface Store {
  route: RouteName;
  meta: HostelMeta | null;
  setRoute: (route: RouteName) => void;
  setMeta: (meta: HostelMeta | null) => void;
}

export const useStore = create<Store>((set) => ({
  route: 'onboarding',
  meta: null,
  setRoute: (route) => set({ route }),
  setMeta: (meta) => set({ meta }),
}));
