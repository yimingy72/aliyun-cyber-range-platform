import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateTeamInput,
  UpdateTeamInput,
} from './admin.repository';

@Injectable()
export class TeamsService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  list(competitionId?: string) {
    return this.adminRepository.listTeams({ competitionId });
  }

  async create(input: CreateTeamInput) {
    const competition = await this.adminRepository.getCompetitionById(input.competitionId);

    if (!competition) {
      throw new NotFoundException('Competition not found');
    }

    return this.adminRepository.createTeam(input);
  }

  async update(id: string, input: UpdateTeamInput) {
    const existingTeam = await this.adminRepository.getTeamById(id);

    if (!existingTeam) {
      throw new NotFoundException('Team not found');
    }

    if (input.competitionId) {
      const competition = await this.adminRepository.getCompetitionById(input.competitionId);

      if (!competition) {
        throw new NotFoundException('Competition not found');
      }
    }

    return this.adminRepository.updateTeam(id, input);
  }

  async delete(id: string) {
    const existingTeam = await this.adminRepository.getTeamById(id);

    if (!existingTeam) {
      throw new NotFoundException('Team not found');
    }

    await this.adminRepository.deleteTeam(id);
  }
}
