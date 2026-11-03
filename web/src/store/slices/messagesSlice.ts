import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { messagesApi } from '@/lib/api';

interface MessagesState {
  unreadCount: number;
}

const initialState: MessagesState = { unreadCount: 0 };

export const fetchMessagesUnread = createAsyncThunk(
  'messages/unreadCount',
  async () => {
    const { data } = await messagesApi.unreadCount();
    return data.count as number;
  }
);

const messagesSlice = createSlice({
  name: 'messages',
  initialState,
  reducers: {
    decrementUnread: (state) => { state.unreadCount = Math.max(0, state.unreadCount - 1); },
    clearUnread:     (state) => { state.unreadCount = 0; },
  },
  extraReducers: (builder) => {
    builder.addCase(fetchMessagesUnread.fulfilled, (state, action) => {
      state.unreadCount = action.payload;
    });
  },
});

export const { decrementUnread, clearUnread } = messagesSlice.actions;
export default messagesSlice.reducer;
