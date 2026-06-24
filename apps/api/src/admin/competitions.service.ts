import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  ADMIN_REPOSITORY,
  AdminRepository,
  CreateCompetitionInput,
  UpdateCompetitionInput,
} from './admin.repository';

@Injectable()
export class CompetitionsService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository) {}

  list() {
    return this.adminRepository.listCompetitions();
  }

  create(input: CreateCompetitionInput) {
    return this.adminRepository.createCompetition(input);
  }

  async update(id: string, input: UpdateCompetitionInput) {
    const existingCompetition = await this.adminRepository.getCompetitionById(id);

    if (!existingCompetition) {
      throw new NotFoundException('Competition not found');
    }

    return this.adminRepository.updateCompetition(id, input);
  }

  async delete(id: string) {
    const existingCompetition = await this.adminRepository.getCompetitionById(id);

    if (!existingCompetition) {
      throw new NotFoundException('Competition not found');
    }

    await this.adminRepository.deleteCompetition(id);
  }
}
