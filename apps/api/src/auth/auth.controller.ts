import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { Public } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto, RefreshDto } from './dto';
import type { AuthedUser } from './auth.service';
import { UsersService } from '../users/users.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Public()
  @Post('login')
  async login(@Req() req: FastifyRequest, @Body() dto: LoginDto) {
    return this.auth.login(req.ip, dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /** 登出：吊销 refresh token（幂等） */
  @Public()
  @Post('logout')
  async logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  /** 当前用户、部门、本月剩余配额（计划书 7.2-3） */
  @Get('me')
  async me(@CurrentUser() user: AuthedUser) {
    return this.users.me(user.userId);
  }
}
