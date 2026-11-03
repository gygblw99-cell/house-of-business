import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSelector } from 'react-redux';

// Auth Screens
import LoginScreen            from '../screens/auth/LoginScreen';
import EmployeeLoginScreen    from '../screens/auth/EmployeeLoginScreen';
import RegisterScreen         from '../screens/auth/RegisterScreen';
import ForgotPasswordScreen   from '../screens/auth/ForgotPasswordScreen';
import ResetPasswordScreen    from '../screens/auth/ResetPasswordScreen';

// Main Screens
import DashboardScreen        from '../screens/dashboard/DashboardScreen';
import EmployeesScreen        from '../screens/employees/EmployeesScreen';
import ShiftsScreen           from '../screens/employees/ShiftsScreen';
import ClockInScreen          from '../screens/employees/ClockInScreen';
import SuppliersScreen        from '../screens/suppliers/SuppliersScreen';
import SupplierDetailScreen   from '../screens/suppliers/SupplierDetailScreen';
import DailyOrdersScreen      from '../screens/suppliers/DailyOrdersScreen';
import InvoicesScreen         from '../screens/invoices/InvoicesScreen';
import InvoiceDetailScreen    from '../screens/invoices/InvoiceDetailScreen';
import InvoiceScanScreen      from '../screens/invoices/InvoiceScanScreen';
import InventoryScreen        from '../screens/inventory/InventoryScreen';
import InventoryItemScreen    from '../screens/inventory/InventoryItemScreen';
import WasteScreen            from '../screens/inventory/WasteScreen';
import RecipesScreen          from '../screens/recipes/RecipesScreen';
import RecipeDetailScreen     from '../screens/recipes/RecipeDetailScreen';
import FinanceScreen          from '../screens/finance/FinanceScreen';
import CashflowScreen         from '../screens/finance/CashflowScreen';
import ForecastScreen         from '../screens/finance/ForecastScreen';
import AiChatScreen           from '../screens/ai/AiChatScreen';
import NotificationsScreen    from '../screens/notifications/NotificationsScreen';
import SettingsScreen         from '../screens/settings/SettingsScreen';
import AuditScreen            from '../screens/audit/AuditScreen';

// New Feature Screens
import MoreScreen             from '../screens/more/MoreScreen';
import TasksScreen            from '../screens/tasks/TasksScreen';
import CustomersScreen        from '../screens/customers/CustomersScreen';
import CustomerDetailScreen   from '../screens/customers/CustomerDetailScreen';
import WeeklyReportScreen     from '../screens/reports/WeeklyReportScreen';
import ReviewsScreen          from '../screens/reviews/ReviewsScreen';
import QueueScreen            from '../screens/queue/QueueScreen';
import MenuEngineeringScreen  from '../screens/menuEngineering/MenuEngineeringScreen';
import PriceComparisonScreen  from '../screens/priceComparison/PriceComparisonScreen';
import GalleryScreen          from '../screens/gallery/GalleryScreen';
import PayrollScreen          from '../screens/payroll/PayrollScreen';
import ZReportsScreen         from '../screens/pos/ZReportsScreen';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown:             false,
        tabBarStyle:             { backgroundColor: '#1E1E2E', borderTopColor: '#374151' },
        tabBarActiveTintColor:   '#6366F1',
        tabBarInactiveTintColor: '#6B7280',
        tabBarLabelStyle:        { fontSize: 11 },
      }}
    >
      <Tab.Screen name="Dashboard" component={DashboardStack} options={{ title: 'בית',       tabBarIcon: ({ color }) => <TabIcon icon="🏠" color={color} /> }} />
      <Tab.Screen name="Employees" component={EmployeesStack} options={{ title: 'עובדים',    tabBarIcon: ({ color }) => <TabIcon icon="👥" color={color} /> }} />
      <Tab.Screen name="Suppliers" component={SuppliersStack} options={{ title: 'ספקים',     tabBarIcon: ({ color }) => <TabIcon icon="🚚" color={color} /> }} />
      <Tab.Screen name="Finance"   component={FinanceStack}   options={{ title: 'כספים',     tabBarIcon: ({ color }) => <TabIcon icon="💰" color={color} /> }} />
      <Tab.Screen name="AiChat"    component={AiChatScreen}   options={{ title: 'יועץ AI',   tabBarIcon: ({ color }) => <TabIcon icon="🤖" color={color} /> }} />
      <Tab.Screen name="More"      component={MoreStack}      options={{ title: 'עוד',        tabBarIcon: ({ color }) => <TabIcon icon="⋯"  color={color} /> }} />
    </Tab.Navigator>
  );
}

import { Text as RNText } from 'react-native';
function TabIcon({ icon, color }) {
  return <RNText style={{ fontSize: 20, color }}>{icon}</RNText>;
}

function DashboardStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="DashboardHome"  component={DashboardScreen} />
      <Stack.Screen name="Audit"          component={AuditScreen} />
      <Stack.Screen name="Notifications"  component={NotificationsScreen} />
      <Stack.Screen name="Settings"       component={SettingsScreen} />
      <Stack.Screen name="Invoices"       component={InvoicesScreen} />
      <Stack.Screen name="InvoiceDetail"  component={InvoiceDetailScreen} />
      <Stack.Screen name="InvoiceScan"    component={InvoiceScanScreen} />
      <Stack.Screen name="Inventory"      component={InventoryScreen} />
      <Stack.Screen name="InventoryItem"  component={InventoryItemScreen} />
      <Stack.Screen name="Waste"          component={WasteScreen} />
      <Stack.Screen name="Recipes"        component={RecipesScreen} />
      <Stack.Screen name="RecipeDetail"   component={RecipeDetailScreen} />
    </Stack.Navigator>
  );
}

function EmployeesStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="EmployeesList" component={EmployeesScreen} />
      <Stack.Screen name="Shifts"        component={ShiftsScreen} />
      <Stack.Screen name="ClockIn"       component={ClockInScreen} />
    </Stack.Navigator>
  );
}

function SuppliersStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="SuppliersList"  component={SuppliersScreen} />
      <Stack.Screen name="SupplierDetail" component={SupplierDetailScreen} />
      <Stack.Screen name="DailyOrders"    component={DailyOrdersScreen} />
    </Stack.Navigator>
  );
}

function FinanceStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="FinanceHome" component={FinanceScreen} />
      <Stack.Screen name="Cashflow"    component={CashflowScreen} />
      <Stack.Screen name="Forecast"    component={ForecastScreen} />
    </Stack.Navigator>
  );
}

function MoreStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreHome"        component={MoreScreen} />
      <Stack.Screen name="Tasks"           component={TasksScreen} />
      <Stack.Screen name="Customers"       component={CustomersScreen} />
      <Stack.Screen name="CustomerDetail"  component={CustomerDetailScreen} />
      <Stack.Screen name="WeeklyReports"   component={WeeklyReportScreen} />
      <Stack.Screen name="Reviews"         component={ReviewsScreen} />
      <Stack.Screen name="Queue"           component={QueueScreen} />
      <Stack.Screen name="MenuEngineering" component={MenuEngineeringScreen} />
      <Stack.Screen name="PriceComparison" component={PriceComparisonScreen} />
      <Stack.Screen name="Gallery"         component={GalleryScreen} />
      <Stack.Screen name="Payroll"         component={PayrollScreen} />
      <Stack.Screen name="ZReports"        component={ZReportsScreen} />
    </Stack.Navigator>
  );
}

export default function AppNavigator() {
  const { user, restored } = useSelector(s => s.auth);

  if (!restored) return null;

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {user ? (
          <Stack.Screen name="Main" component={MainTabs} />
        ) : (
          <>
            <Stack.Screen name="Login"          component={LoginScreen} />
            <Stack.Screen name="EmployeeLogin"  component={EmployeeLoginScreen} />
            <Stack.Screen name="Register"       component={RegisterScreen} />
            <Stack.Screen name="ForgotPassword" component={ForgotPasswordScreen} />
            <Stack.Screen name="ResetPassword"  component={ResetPasswordScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
