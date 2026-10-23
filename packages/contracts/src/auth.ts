import { z } from "zod";
import { idSchema } from "./common.js";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

const emailSchema = z.string().trim().toLowerCase().email().max(320);
/** Length is the rule that matters most. The server also refuses a password that is the email or a very common one. */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH);

export const registerSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    displayName: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }).strict();

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH), newPassword: newPasswordSchema })
  .strict();

export const deleteAccountSchema = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }).strict();

export const authUserSchema = z.object({ id: idSchema, email: z.string(), displayName: z.string().nullable() });
export const authSessionSchema = z.object({ user: authUserSchema });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
