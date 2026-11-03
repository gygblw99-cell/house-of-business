import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../services/api';

export const fetchNotifications = createAsyncThunk('notifications/fetch', async () => {
  return api.getNotifications();
});

export const fetchUnreadCount = createAsyncThunk('notifications/unread', async () => {
  return api.getUnreadCount();
});

export const markRead = createAsyncThunk('notifications/markRead', async (id) => {
  await api.markRead(id);
  return id;
});

export const markAllRead = createAsyncThunk('notifications/markAllRead', async () => {
  await api.markAllRead();
});

const notificationsSlice = createSlice({
  name: 'notifications',
  initialState: { items: [], unreadCount: 0, loading: false },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchNotifications.fulfilled, (state, action) => {
        state.items = action.payload?.notifications || action.payload || [];
      })
      .addCase(fetchUnreadCount.fulfilled, (state, action) => {
        state.unreadCount = action.payload?.count ?? action.payload?.unread_count ?? 0;
      })
      .addCase(markRead.fulfilled, (state, action) => {
        const n = state.items.find(i => i.id === action.payload);
        if (n && !n.is_read) { n.is_read = true; state.unreadCount = Math.max(0, state.unreadCount - 1); }
      })
      .addCase(markAllRead.fulfilled, (state) => {
        state.items.forEach(i => { i.is_read = true; });
        state.unreadCount = 0;
      });
  },
});

export default notificationsSlice.reducer;
