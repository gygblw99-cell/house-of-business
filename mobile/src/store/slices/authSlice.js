import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { saveToken, loadToken, clearToken, decodeJwtPayload } from '../../services/api';

// Token reads/writes MUST go through api.js's saveToken/loadToken/clearToken
// (Keychain-first, with legacy AsyncStorage fallback/migration) — not raw
// AsyncStorage here. api.js's request layer always resolves the token via
// loadToken(), which checks Keychain FIRST; a login here that wrote straight
// to AsyncStorage would be invisible to every subsequent request as long as
// Keychain still held an older token, and a logout that only cleared
// AsyncStorage would leave that older token live in Keychain — on a shared
// device, the next employee's login could silently authenticate as whoever
// logged in previously.
export const loginOwner = createAsyncThunk('auth/loginOwner', async ({ email, password }, { rejectWithValue }) => {
  try {
    const data = await api.login(email, password);
    await saveToken(data.token);
    // שמור גם business כדי שיהיה זמין אחרי restart
    if (data.business) await AsyncStorage.setItem('business', JSON.stringify(data.business));
    return data;
  } catch (err) { return rejectWithValue(err.message); }
});

export const loginEmployee = createAsyncThunk('auth/loginEmployee', async ({ username, password }, { rejectWithValue }) => {
  try {
    const data = await api.loginEmployee(username, password);
    await saveToken(data.token);
    if (data.business) await AsyncStorage.setItem('business', JSON.stringify(data.business));
    return data;
  } catch (err) { return rejectWithValue(err.message); }
});

export const logout = createAsyncThunk('auth/logout', async () => {
  await clearToken();
  await AsyncStorage.removeItem('business');
});

export const restoreSession = createAsyncThunk('auth/restore', async (_, { rejectWithValue }) => {
  try {
    const [tokenVal, businessJson] = await Promise.all([
      loadToken(),
      AsyncStorage.getItem('business'),
    ]);
    const businessVal = businessJson ? JSON.parse(businessJson) : null;

    if (!tokenVal) return null;

    // פענוח JWT
    const payload = decodeJwtPayload(tokenVal);
    if (payload.exp * 1000 < Date.now()) {
      await clearToken();
      await AsyncStorage.removeItem('business');
      return null;
    }

    return { token: tokenVal, user: payload, business: businessVal };
  } catch { return rejectWithValue(null); }
});

const authSlice = createSlice({
  name: 'auth',
  initialState: { user: null, business: null, token: null, loading: false, error: null, restored: false },
  reducers: {
    clearError: (state) => { state.error = null; },
  },
  extraReducers: (builder) => {
    const handlePending   = (state)         => { state.loading = true;  state.error = null; };
    const handleFulfilled = (state, action) => {
      state.loading = false;
      if (action.payload) {
        state.token    = action.payload.token;
        state.user     = action.payload.user || action.payload;
        state.business = action.payload.business || null;
      }
    };
    const handleRejected  = (state, action) => { state.loading = false; state.error = action.payload; };

    builder
      .addCase(loginOwner.pending,      handlePending)
      .addCase(loginOwner.fulfilled,    handleFulfilled)
      .addCase(loginOwner.rejected,     handleRejected)
      .addCase(loginEmployee.pending,   handlePending)
      .addCase(loginEmployee.fulfilled, handleFulfilled)
      .addCase(loginEmployee.rejected,  handleRejected)
      .addCase(logout.fulfilled, (state) => {
        state.user = null; state.token = null; state.business = null;
      })
      .addCase(restoreSession.fulfilled, (state, action) => {
        state.restored = true;
        if (action.payload) {
          state.token    = action.payload.token;
          state.user     = action.payload.user;
          state.business = action.payload.business;
        }
      })
      .addCase(restoreSession.rejected, (state) => { state.restored = true; });
  },
});

export const { clearError } = authSlice.actions;
export default authSlice.reducer;
