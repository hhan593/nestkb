import { Global, Module, Inject } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ENV } from '@app/common';
import type { AppEnv } from '@app/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { UsersModule } from '../users/users.module';

@Global()
@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      useFactory: (env: AppEnv) => ({ secret: env.jwtSecret }),
      inject: [ENV],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
