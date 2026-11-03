import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { notificationsApi } from '@/lib/api';
import type { Notification } from '@/types';

interface NotificationsState {
  items: Notification[];
  unreadCount: number;
  loading: boolean;
}

const initialState: NotificationsState = {
  items: [],
  unreadCount: 0,
  loading: false,
};

export const fetchNotifications = createAsyncThunk(
  'notifications/fetch',
  async () => {
    const { data } = await notificationsApi.list();
    return data;
  }
);

export const fetchUnreadCount = createAsyncThunk(
  'notifications/unreadCount',
  async () => {
    const { data } = await notificationsApi.unreadCount();
    return data.count;
  }
);

export const markRead = createAsyncThunk(
  'notifications/markRead',
  async (id: string) => {
    await notificationsApi.markRead(id);
    return id;
  }
);

export const markAllRead = createAsyncThunk(
  'notifications/markAllRead',
  async () => {
    await notificationsApi.markAllRead();
  }
);

export const deleteNotification = createAsyncThunk(
  'notifications/delete',
  async (id: string) => {
    await notificationsApi.delete(id);
    return id;
  }
);

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchNotifications.pending, (state) => { state.loading = true; })
      .addCase(fetchNotifications.fulfilled, (state, action) => {
        state.loading = false;
        state.items = action.payload.notifications || [];
        state.unreadCount = state.items.filter((n) => !n.is_read).length;
      })
      .addCase(fetchUnreadCount.fulfilled, (state, action) => {
        state.unreadCount = action.payload;
      })
      .addCase(markRead.fulfilled, (state, action) => {
        const n = state.items.find((i) => i.id === action.payload);
        if (n && !n.is_read) {
          n.is_read = true;
          state.unreadCount = Math.max(0, state.unreadCount - 1);
        }
      })
      .addCase(markAllRead.fulfilled, (state) => {
        state.items.forEach((n) => { n.is_read = true; });
        state.unreadCount = 0;
      })
      .addCase(deleteNotification.fulfilled, (state, action) => {
        const n = state.items.find((i) => i.id === action.payload);
        if (n && !n.is_read) state.unreadCount = Math.max(0, state.unreadCount - 1);
        state.items = state.items.filter((i) => i.id !== action.payload);
      });
  },
});

export default notificationsSlice.reducer;
