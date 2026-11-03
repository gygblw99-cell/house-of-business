import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import Cookies from 'js-cookie';
import { authApi } from '@/lib/api';
import type { User, Business } from '@/types';

interface AuthState {
  user: User | null;
  business: Business | null;
  loading: boolean;
  error: string | null;
  // Password accepted, but the server is withholding the token until a valid
  // TOTP code arrives. Drives the code field on the login screens.
  requires2FA: boolean;
}

const initialState: AuthState = {
  user: null,
  business: null,
  loading: false,
  error: null,
  requires2FA: false,
};

// A login attempt either completes (token + user) or advances to the TOTP step.
// Both are *successful* outcomes of the flow — modelling the 2FA step as a
// rejection is what previously leaked the raw '__2fa_required__' sentinel into
// the login screen's error box, with no way for the user to supply a code.
type LoginSuccess = { token: string; user: User; business: Business | null };
type LoginResult  = LoginSuccess | { requires2FA: true };

function isTwoFactorStep(r: LoginResult): r is { requires2FA: true } {
  return 'requires2FA' in r;
}

const TOKEN_COOKIE_OPTS = { expires: 7, secure: true, sameSite: 'Lax' } as const;

// Distinguishes three genuinely different situations that a generic
// "שגיאת התחברות" fallback used to collapse into one confusing message:
//   1. The server actually responded (e.g. wrong username/password, account
//      disabled) — show its message as-is. Never split "wrong username" from
//      "wrong password" here; that's a deliberate security choice, not an
//      oversight — it prevents an attacker from using the login form to
//      discover which usernames exist.
//   2. The request never got a response at all (offline device, DNS/CORS
//      failure, server unreachable) — axios sets `.request` but not
//      `.response` for this case.
//   3. Anything else (a bug on our side setting up the request).
function getAuthErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } }; request?: unknown };
  if (e.response) return e.response.data?.error || 'שגיאת התחברות';
  if (e.request) return 'לא ניתן להתחבר לשרת — בדוק את החיבור לאינטרנט ונסה שוב';
  return 'שגיאה לא צפויה — נסה שוב';
}

export const login = createAsyncThunk<
  LoginResult,
  { username: string; password: string; totpCode?: string },
  { rejectValue: string }
>(
  'auth/login',
  async ({ username, password, totpCode }, { rejectWithValue }) => {
    try {
      const { data } = await authApi.login(username, password, totpCode);
      if (data.requires2FA) return { requires2FA: true as const };
      Cookies.set('token', data.token, TOKEN_COOKIE_OPTS);
      return data as LoginSuccess;
    } catch (err: unknown) {
      return rejectWithValue(getAuthErrorMessage(err));
    }
  }
);

export const loginEmployee = createAsyncThunk<
  LoginResult,
  { username: string; password: string; totpCode?: string },
  { rejectValue: string }
>(
  'auth/loginEmployee',
  async ({ username, password, totpCode }, { rejectWithValue }) => {
    try {
      const { data } = await authApi.loginEmployee(username, password, totpCode);
      if (data.requires2FA) return { requires2FA: true as const };
      Cookies.set('token', data.token, TOKEN_COOKIE_OPTS);
      return data as LoginSuccess;
    } catch (err: unknown) {
      return rejectWithValue(getAuthErrorMessage(err));
    }
  }
);

export const restoreSession = createAsyncThunk(
  'auth/restoreSession',
  async (_, { rejectWithValue }) => {
    try {
      const token = Cookies.get('token');
      if (!token) return rejectWithValue('no token');
      const { data } = await authApi.me();
      return data;
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      // מחק cookie רק אם הטוקן אינו תקין (401) — לא על שגיאות רשת זמניות
      if (status === 401) Cookies.remove('token');
      return rejectWithValue(status === 401 ? 'session expired' : 'network error');
    }
  }
);

export const logout = createAsyncThunk('auth/logout', async () => {
  try { await authApi.logout(); } catch {}
  Cookies.remove('token');
});

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    clearError: (state) => { state.error = null; },
    // Back out of the TOTP step (user wants to re-enter username/password).
    cancel2FA: (state) => { state.requires2FA = false; state.error = null; },
  },
  extraReducers: (builder) => {
    // login and loginEmployee behave identically — same pending/fulfilled/
    // rejected shape — so they share reducers instead of duplicating them.
    const onPending = (state: AuthState) => {
      state.loading = true;
      state.error = null;
    };
    const onFulfilled = (state: AuthState, action: { payload: LoginResult }) => {
      state.loading = false;
      if (isTwoFactorStep(action.payload)) {
        state.requires2FA = true;
        return;
      }
      state.requires2FA = false;
      state.user = action.payload.user;
      state.business = action.payload.business;
    };
    // Deliberately leaves `requires2FA` alone: a wrong code must keep the code
    // field on screen so the user can retry, rather than bouncing them back to
    // the password step (where re-submitting would just ask for a code again).
    const onRejected = (state: AuthState, action: { payload?: string }) => {
      state.loading = false;
      state.error = action.payload ?? 'שגיאת התחברות';
    };

    builder
      .addCase(login.pending, onPending)
      .addCase(login.fulfilled, onFulfilled)
      .addCase(login.rejected, onRejected)
      .addCase(loginEmployee.pending, onPending)
      .addCase(loginEmployee.fulfilled, onFulfilled)
      .addCase(loginEmployee.rejected, onRejected)
      .addCase(restoreSession.fulfilled, (state, action) => {
        state.user = action.payload.user;
        state.business = action.payload.business;
      })
      .addCase(restoreSession.rejected, (state) => {
        state.user = null;
        state.business = null;
      })
      .addCase(logout.fulfilled, (state) => {
        state.user = null;
        state.business = null;
        state.requires2FA = false;
      });
  },
});

export const { clearError, cancel2FA } = authSlice.actions;
export default authSlice.reducer;
