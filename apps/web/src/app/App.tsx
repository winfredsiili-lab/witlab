import { AuthProvider } from "../features/auth/AuthContext";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AuthProvider>
  );
}
