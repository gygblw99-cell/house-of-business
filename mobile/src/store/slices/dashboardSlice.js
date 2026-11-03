import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import api from '../../services/api';

export const fetchDashboard = createAsyncThunk('dashboard/fetch', async (_, { rejectWithValue }) => {
  try { return await api.getDashboard(); }
  catch (err) { return rejectWithValue(err.message); }
});

const dashboardSlice = createSlice({
  name: 'dashboard',
  initialState: { data: null, loading: false, error: null, lastUpdated: null },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchDashboard.pending,   (state) => { state.loading = true; state.error = null; })
      .addCase(fetchDashboard.fulfilled, (state, action) => {
        state.loading = false; state.data = action.payload; state.lastUpdated = Date.now();
      })
      .addCase(fetchDashboard.rejected,  (state, action) => {
        state.loading = false; state.error = action.payload;
      });
  },
});

export default dashboardSlice.reducer;
