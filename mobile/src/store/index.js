import { configureStore } from '@reduxjs/toolkit';
import authReducer         from './slices/authSlice';
import dashboardReducer    from './slices/dashboardSlice';
import notificationsReducer from './slices/notificationsSlice';

export const store = configureStore({
  reducer: {
    auth:          authReducer,
    dashboard:     dashboardReducer,
    notifications: notificationsReducer,
  },
});
