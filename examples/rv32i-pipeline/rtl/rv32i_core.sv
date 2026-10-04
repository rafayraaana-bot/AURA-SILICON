module rv32i_core #(
  parameter logic [31:0] RESET_VECTOR = 32'h0000_0000
) (
  input  logic        clk_i,
  input  logic        reset_ni,
  output logic [31:0] instr_addr_o,
  input  logic [31:0] instr_rdata_i,
  output logic        data_req_o,
  output logic        data_we_o,
  output logic [3:0]  data_wstrb_o,
  output logic [31:0] data_addr_o,
  output logic [31:0] data_wdata_o,
  input  logic [31:0] data_rdata_i
);
  localparam logic [6:0] OPCODE_LOAD   = 7'b0000011;
  localparam logic [6:0] OPCODE_MISC   = 7'b0001111;
  localparam logic [6:0] OPCODE_OPIMM  = 7'b0010011;
  localparam logic [6:0] OPCODE_AUIPC  = 7'b0010111;
  localparam logic [6:0] OPCODE_STORE  = 7'b0100011;
  localparam logic [6:0] OPCODE_OP     = 7'b0110011;
  localparam logic [6:0] OPCODE_LUI    = 7'b0110111;
  localparam logic [6:0] OPCODE_BRANCH = 7'b1100011;
  localparam logic [6:0] OPCODE_JALR   = 7'b1100111;
  localparam logic [6:0] OPCODE_JAL    = 7'b1101111;

  localparam logic [3:0] ALU_ADD  = 4'd0;
  localparam logic [3:0] ALU_SUB  = 4'd1;
  localparam logic [3:0] ALU_SLL  = 4'd2;
  localparam logic [3:0] ALU_SLT  = 4'd3;
  localparam logic [3:0] ALU_SLTU = 4'd4;
  localparam logic [3:0] ALU_XOR  = 4'd5;
  localparam logic [3:0] ALU_SRL  = 4'd6;
  localparam logic [3:0] ALU_SRA  = 4'd7;
  localparam logic [3:0] ALU_OR   = 4'd8;
  localparam logic [3:0] ALU_AND  = 4'd9;

  localparam logic [1:0] WB_ALU = 2'd0;
  localparam logic [1:0] WB_LOAD = 2'd1;
  localparam logic [1:0] WB_PC4 = 2'd2;
  localparam logic [1:0] WB_IMMEDIATE = 2'd3;

  logic [31:0] registers [0:31];
  logic [31:0] pc_q;

  logic        ifid_valid_q;
  logic [31:0] ifid_pc_q;
  logic [31:0] ifid_instr_q;

  logic        idex_valid_q;
  logic [31:0] idex_pc_q;
  logic [31:0] idex_pc4_q;
  logic [31:0] idex_rs1_value_q;
  logic [31:0] idex_rs2_value_q;
  logic [31:0] idex_immediate_q;
  logic [4:0]  idex_rs1_q;
  logic [4:0]  idex_rs2_q;
  logic [4:0]  idex_rd_q;
  logic [2:0]  idex_funct3_q;
  logic [3:0]  idex_alu_op_q;
  logic [1:0]  idex_wb_sel_q;
  logic [2:0]  idex_branch_q;
  logic        idex_uses_pc_q;
  logic        idex_uses_imm_q;
  logic        idex_regwrite_q;
  logic        idex_memread_q;
  logic        idex_memwrite_q;

  logic        exmem_valid_q;
  logic [31:0] exmem_result_q;
  logic [31:0] exmem_pc4_q;
  logic [31:0] exmem_store_data_q;
  logic [4:0]  exmem_rd_q;
  logic [2:0]  exmem_funct3_q;
  logic [1:0]  exmem_wb_sel_q;
  logic        exmem_regwrite_q;
  logic        exmem_memread_q;
  logic        exmem_memwrite_q;

  logic        memwb_valid_q;
  logic [31:0] memwb_result_q;
  logic [4:0]  memwb_rd_q;
  logic        memwb_regwrite_q;

  logic [31:0] instr_rs1_value;
  logic [31:0] instr_rs2_value;
  logic [4:0]  instr_rs1;
  logic [4:0]  instr_rs2;
  logic [4:0]  instr_rd;
  logic [6:0]  instr_opcode;
  logic [2:0]  instr_funct3;
  logic [6:0]  instr_funct7;
  logic [31:0] instr_immediate;
  logic [3:0]  instr_alu_op;
  logic [1:0]  instr_wb_sel;
  logic [2:0]  instr_branch;
  logic        instr_uses_rs1;
  logic        instr_uses_rs2;
  logic        instr_uses_pc;
  logic        instr_uses_imm;
  logic        instr_regwrite;
  logic        instr_memread;
  logic        instr_memwrite;
  logic        instr_valid;

  logic [31:0] ex_rs1_value;
  logic [31:0] ex_rs2_value;
  logic [31:0] ex_operand_a;
  logic [31:0] ex_operand_b;
  logic [31:0] ex_alu_result;
  logic [31:0] ex_result;
  logic [31:0] ex_branch_target;
  logic        ex_branch_taken;
  logic        load_use_stall;
  logic [31:0] exmem_forward_value;
  logic [31:0] exmem_wb_value;
  logic [31:0] data_load_value;
  logic [7:0]  data_load_byte;
  logic [15:0] data_load_half;
  integer index;

  assign instr_addr_o = pc_q;
  assign data_req_o = exmem_valid_q && (exmem_memread_q || exmem_memwrite_q);
  assign data_we_o = exmem_valid_q && exmem_memwrite_q;
  assign data_addr_o = {exmem_result_q[31:2], 2'b00};

  always @* begin
    data_wstrb_o = 4'b0000;
    data_wdata_o = 32'b0;
    if (data_we_o) begin
      case (exmem_funct3_q)
        3'b000: begin
          data_wstrb_o = 4'b0001 << exmem_result_q[1:0];
          data_wdata_o = {24'b0, exmem_store_data_q[7:0]} << (exmem_result_q[1:0] * 8);
        end
        3'b001: begin
          data_wstrb_o = 4'b0011 << exmem_result_q[1:0];
          data_wdata_o = {16'b0, exmem_store_data_q[15:0]} << (exmem_result_q[1:0] * 8);
        end
        3'b010: begin
          data_wstrb_o = 4'b1111;
          data_wdata_o = exmem_store_data_q;
        end
        default: begin
          data_wstrb_o = 4'b0000;
          data_wdata_o = 32'b0;
        end
      endcase
    end
  end

  always @* begin
    case (exmem_result_q[1:0])
      2'd0: data_load_byte = data_rdata_i[7:0];
      2'd1: data_load_byte = data_rdata_i[15:8];
      2'd2: data_load_byte = data_rdata_i[23:16];
      2'd3: data_load_byte = data_rdata_i[31:24];
      default: data_load_byte = 8'b0;
    endcase
    data_load_half = exmem_result_q[1] ? data_rdata_i[31:16] : data_rdata_i[15:0];
    data_load_value = 32'b0;
    case (exmem_funct3_q)
      3'b000: data_load_value = {{24{data_load_byte[7]}}, data_load_byte};
      3'b001: data_load_value = {{16{data_load_half[15]}}, data_load_half};
      3'b010: data_load_value = data_rdata_i;
      3'b100: data_load_value = {24'b0, data_load_byte};
      3'b101: data_load_value = {16'b0, data_load_half};
      default: data_load_value = 32'b0;
    endcase
  end

  always @* begin
    instr_opcode = ifid_instr_q[6:0];
    instr_rd = ifid_instr_q[11:7];
    instr_funct3 = ifid_instr_q[14:12];
    instr_rs1 = ifid_instr_q[19:15];
    instr_rs2 = ifid_instr_q[24:20];
    instr_funct7 = ifid_instr_q[31:25];
    instr_rs1_value = (instr_rs1 == 0) ? 32'b0 : registers[instr_rs1];
    instr_rs2_value = (instr_rs2 == 0) ? 32'b0 : registers[instr_rs2];
    instr_immediate = {{20{ifid_instr_q[31]}}, ifid_instr_q[31:20]};
    instr_alu_op = ALU_ADD;
    instr_wb_sel = WB_ALU;
    instr_branch = 3'b000;
    instr_uses_rs1 = 1'b0;
    instr_uses_rs2 = 1'b0;
    instr_uses_pc = 1'b0;
    instr_uses_imm = 1'b0;
    instr_regwrite = 1'b0;
    instr_memread = 1'b0;
    instr_memwrite = 1'b0;
    instr_valid = 1'b0;

    case (instr_opcode)
      OPCODE_LUI: begin
        instr_valid = 1'b1;
        instr_immediate = {ifid_instr_q[31:12], 12'b0};
        instr_wb_sel = WB_IMMEDIATE;
        instr_regwrite = 1'b1;
      end
      OPCODE_AUIPC: begin
        instr_valid = 1'b1;
        instr_immediate = {ifid_instr_q[31:12], 12'b0};
        instr_uses_pc = 1'b1;
        instr_uses_imm = 1'b1;
        instr_regwrite = 1'b1;
      end
      OPCODE_JAL: begin
        instr_valid = 1'b1;
        instr_immediate = {{11{ifid_instr_q[31]}}, ifid_instr_q[31], ifid_instr_q[19:12],
                           ifid_instr_q[20], ifid_instr_q[30:21], 1'b0};
        instr_uses_pc = 1'b1;
        instr_wb_sel = WB_PC4;
        instr_regwrite = 1'b1;
      end
      OPCODE_JALR: begin
        if (instr_funct3 == 3'b000) begin
          instr_valid = 1'b1;
          instr_uses_rs1 = 1'b1;
          instr_uses_imm = 1'b1;
          instr_wb_sel = WB_PC4;
          instr_regwrite = 1'b1;
        end
      end
      OPCODE_BRANCH: begin
        instr_immediate = {{19{ifid_instr_q[31]}}, ifid_instr_q[31], ifid_instr_q[7],
                           ifid_instr_q[30:25], ifid_instr_q[11:8], 1'b0};
        case (instr_funct3)
          3'b000: begin instr_valid = 1'b1; instr_branch = 3'd1; end
          3'b001: begin instr_valid = 1'b1; instr_branch = 3'd2; end
          3'b100: begin instr_valid = 1'b1; instr_branch = 3'd3; end
          3'b101: begin instr_valid = 1'b1; instr_branch = 3'd4; end
          3'b110: begin instr_valid = 1'b1; instr_branch = 3'd5; end
          3'b111: begin instr_valid = 1'b1; instr_branch = 3'd6; end
          default: begin end
        endcase
        instr_uses_rs1 = instr_valid;
        instr_uses_rs2 = instr_valid;
      end
      OPCODE_LOAD: begin
        if (instr_funct3 == 3'b000 || instr_funct3 == 3'b001 ||
            instr_funct3 == 3'b010 || instr_funct3 == 3'b100 ||
            instr_funct3 == 3'b101) begin
          instr_valid = 1'b1;
          instr_uses_rs1 = 1'b1;
          instr_uses_imm = 1'b1;
          instr_regwrite = 1'b1;
          instr_memread = 1'b1;
          instr_wb_sel = WB_LOAD;
        end
      end
      OPCODE_STORE: begin
        if (instr_funct3 == 3'b000 || instr_funct3 == 3'b001 || instr_funct3 == 3'b010) begin
          instr_valid = 1'b1;
          instr_immediate = {{20{ifid_instr_q[31]}}, ifid_instr_q[31:25], ifid_instr_q[11:7]};
          instr_uses_rs1 = 1'b1;
          instr_uses_rs2 = 1'b1;
          instr_uses_imm = 1'b1;
          instr_memwrite = 1'b1;
        end
      end
      OPCODE_OPIMM: begin
        instr_uses_rs1 = 1'b1;
        instr_uses_imm = 1'b1;
        case (instr_funct3)
          3'b000: begin instr_valid = 1'b1; instr_alu_op = ALU_ADD; end
          3'b010: begin instr_valid = 1'b1; instr_alu_op = ALU_SLT; end
          3'b011: begin instr_valid = 1'b1; instr_alu_op = ALU_SLTU; end
          3'b100: begin instr_valid = 1'b1; instr_alu_op = ALU_XOR; end
          3'b110: begin instr_valid = 1'b1; instr_alu_op = ALU_OR; end
          3'b111: begin instr_valid = 1'b1; instr_alu_op = ALU_AND; end
          3'b001: begin
            if (instr_funct7 == 7'b0000000) begin
              instr_valid = 1'b1;
              instr_alu_op = ALU_SLL;
              instr_immediate = {27'b0, ifid_instr_q[24:20]};
            end
          end
          3'b101: begin
            if (instr_funct7 == 7'b0000000 || instr_funct7 == 7'b0100000) begin
              instr_valid = 1'b1;
              instr_alu_op = (instr_funct7[5]) ? ALU_SRA : ALU_SRL;
              instr_immediate = {27'b0, ifid_instr_q[24:20]};
            end
          end
          default: begin end
        endcase
        instr_regwrite = instr_valid;
      end
      OPCODE_OP: begin
        instr_uses_rs1 = 1'b1;
        instr_uses_rs2 = 1'b1;
        if (instr_funct7 == 7'b0000000 || instr_funct7 == 7'b0100000) begin
          case (instr_funct3)
            3'b000: begin
              instr_valid = 1'b1;
              instr_alu_op = instr_funct7[5] ? ALU_SUB : ALU_ADD;
            end
            3'b001: begin
              if (instr_funct7 == 7'b0000000) begin instr_valid = 1'b1; instr_alu_op = ALU_SLL; end
            end
            3'b010: begin
              if (instr_funct7 == 7'b0000000) begin instr_valid = 1'b1; instr_alu_op = ALU_SLT; end
            end
            3'b011: begin
              if (instr_funct7 == 7'b0000000) begin instr_valid = 1'b1; instr_alu_op = ALU_SLTU; end
            end
            3'b100: begin
              if (instr_funct7 == 7'b0000000) begin instr_valid = 1'b1; instr_alu_op = ALU_XOR; end
            end
            3'b101: begin
              instr_valid = 1'b1;
              instr_alu_op = instr_funct7[5] ? ALU_SRA : ALU_SRL;
            end
            3'b110: begin
              if (instr_funct7 == 7'b0000000) begin instr_valid = 1'b1; instr_alu_op = ALU_OR; end
            end
            3'b111: begin
              if (instr_funct7 == 7'b0000000) begin instr_valid = 1'b1; instr_alu_op = ALU_AND; end
            end
            default: begin end
          endcase
        end
        instr_regwrite = instr_valid;
      end
      OPCODE_MISC: begin
        if (instr_funct3 == 3'b000) instr_valid = 1'b1;
      end
      default: begin end
    endcase

    if (!ifid_valid_q) begin
      instr_valid = 1'b0;
      instr_regwrite = 1'b0;
      instr_memread = 1'b0;
      instr_memwrite = 1'b0;
      instr_branch = 3'b000;
    end
  end

  always @* begin
    exmem_forward_value = (exmem_wb_sel_q == WB_PC4) ? exmem_pc4_q : exmem_result_q;
    ex_rs1_value = idex_rs1_value_q;
    ex_rs2_value = idex_rs2_value_q;
    if (exmem_valid_q && exmem_regwrite_q && !exmem_memread_q && (exmem_rd_q != 0)) begin
      if (exmem_rd_q == idex_rs1_q) ex_rs1_value = exmem_forward_value;
      if (exmem_rd_q == idex_rs2_q) ex_rs2_value = exmem_forward_value;
    end
    if (memwb_valid_q && memwb_regwrite_q && (memwb_rd_q != 0)) begin
      if (!(exmem_valid_q && exmem_regwrite_q && !exmem_memread_q && (exmem_rd_q == idex_rs1_q)) &&
          memwb_rd_q == idex_rs1_q) ex_rs1_value = memwb_result_q;
      if (!(exmem_valid_q && exmem_regwrite_q && !exmem_memread_q && (exmem_rd_q == idex_rs2_q)) &&
          memwb_rd_q == idex_rs2_q) ex_rs2_value = memwb_result_q;
    end

    ex_operand_a = idex_uses_pc_q ? idex_pc_q : ex_rs1_value;
    ex_operand_b = idex_uses_imm_q ? idex_immediate_q : ex_rs2_value;
    ex_alu_result = 32'b0;
    case (idex_alu_op_q)
      ALU_ADD:  ex_alu_result = ex_operand_a + ex_operand_b;
      ALU_SUB:  ex_alu_result = ex_operand_a - ex_operand_b;
      ALU_SLL:  ex_alu_result = ex_operand_a << ex_operand_b[4:0];
      ALU_SLT:  ex_alu_result = ($signed(ex_operand_a) < $signed(ex_operand_b)) ? 32'd1 : 32'd0;
      ALU_SLTU: ex_alu_result = (ex_operand_a < ex_operand_b) ? 32'd1 : 32'd0;
      ALU_XOR:  ex_alu_result = ex_operand_a ^ ex_operand_b;
      ALU_SRL:  ex_alu_result = ex_operand_a >> ex_operand_b[4:0];
      ALU_SRA:  ex_alu_result = $signed(ex_operand_a) >>> ex_operand_b[4:0];
      ALU_OR:   ex_alu_result = ex_operand_a | ex_operand_b;
      ALU_AND:  ex_alu_result = ex_operand_a & ex_operand_b;
      default:  ex_alu_result = 32'b0;
    endcase
    ex_result = (idex_wb_sel_q == WB_IMMEDIATE) ? idex_immediate_q : ex_alu_result;
    ex_branch_target = idex_pc_q + idex_immediate_q;
    ex_branch_taken = 1'b0;
    case (idex_branch_q)
      3'd1: ex_branch_taken = (ex_rs1_value == ex_rs2_value);
      3'd2: ex_branch_taken = (ex_rs1_value != ex_rs2_value);
      3'd3: ex_branch_taken = ($signed(ex_rs1_value) < $signed(ex_rs2_value));
      3'd4: ex_branch_taken = ($signed(ex_rs1_value) >= $signed(ex_rs2_value));
      3'd5: ex_branch_taken = (ex_rs1_value < ex_rs2_value);
      3'd6: ex_branch_taken = (ex_rs1_value >= ex_rs2_value);
      default: begin
        if (idex_valid_q && (idex_wb_sel_q == WB_PC4)) ex_branch_taken = 1'b1;
      end
    endcase
    if (idex_valid_q && (idex_wb_sel_q == WB_PC4) && (idex_branch_q == 0))
      ex_branch_target = idex_uses_pc_q ? (idex_pc_q + idex_immediate_q) : (ex_rs1_value + idex_immediate_q);
    if (idex_valid_q && (idex_wb_sel_q == WB_PC4) && (idex_branch_q == 0) && !idex_uses_pc_q)
      ex_branch_target[0] = 1'b0;
  end

  assign load_use_stall = ifid_valid_q && idex_valid_q && idex_memread_q && (idex_rd_q != 0) &&
    (((instr_uses_rs1) && (instr_rs1 == idex_rd_q)) ||
     ((instr_uses_rs2) && (instr_rs2 == idex_rd_q)));

  always @* begin
    exmem_wb_value = exmem_result_q;
    case (exmem_wb_sel_q)
      WB_LOAD: exmem_wb_value = data_load_value;
      WB_PC4: exmem_wb_value = exmem_pc4_q;
      default: begin end
    endcase
  end

  always @(posedge clk_i) begin
    if (!reset_ni) begin
      pc_q <= RESET_VECTOR;
      ifid_valid_q <= 1'b0;
      ifid_pc_q <= 32'b0;
      ifid_instr_q <= 32'b0;
      idex_valid_q <= 1'b0;
      idex_pc_q <= 32'b0;
      idex_pc4_q <= 32'b0;
      idex_rs1_value_q <= 32'b0;
      idex_rs2_value_q <= 32'b0;
      idex_immediate_q <= 32'b0;
      idex_rs1_q <= 5'b0;
      idex_rs2_q <= 5'b0;
      idex_rd_q <= 5'b0;
      idex_funct3_q <= 3'b0;
      idex_alu_op_q <= ALU_ADD;
      idex_wb_sel_q <= WB_ALU;
      idex_branch_q <= 3'b0;
      idex_uses_pc_q <= 1'b0;
      idex_uses_imm_q <= 1'b0;
      idex_regwrite_q <= 1'b0;
      idex_memread_q <= 1'b0;
      idex_memwrite_q <= 1'b0;
      exmem_valid_q <= 1'b0;
      exmem_result_q <= 32'b0;
      exmem_pc4_q <= 32'b0;
      exmem_store_data_q <= 32'b0;
      exmem_rd_q <= 5'b0;
      exmem_funct3_q <= 3'b0;
      exmem_wb_sel_q <= WB_ALU;
      exmem_regwrite_q <= 1'b0;
      exmem_memread_q <= 1'b0;
      exmem_memwrite_q <= 1'b0;
      memwb_valid_q <= 1'b0;
      memwb_result_q <= 32'b0;
      memwb_rd_q <= 5'b0;
      memwb_regwrite_q <= 1'b0;
      for (index = 0; index < 32; index = index + 1) registers[index] <= 32'b0;
    end else begin
      if (memwb_valid_q && memwb_regwrite_q && (memwb_rd_q != 0))
        registers[memwb_rd_q] <= memwb_result_q;
      registers[0] <= 32'b0;

      memwb_valid_q <= exmem_valid_q;
      memwb_rd_q <= exmem_rd_q;
      memwb_regwrite_q <= exmem_regwrite_q;
      memwb_result_q <= exmem_wb_value;

      exmem_valid_q <= idex_valid_q;
      exmem_result_q <= ex_result;
      exmem_pc4_q <= idex_pc4_q;
      exmem_store_data_q <= ex_rs2_value;
      exmem_rd_q <= idex_rd_q;
      exmem_funct3_q <= idex_funct3_q;
      exmem_wb_sel_q <= idex_wb_sel_q;
      exmem_regwrite_q <= idex_regwrite_q;
      exmem_memread_q <= idex_memread_q;
      exmem_memwrite_q <= idex_memwrite_q;

      if (ex_branch_taken && idex_valid_q) begin
        pc_q <= ex_branch_target;
        ifid_valid_q <= 1'b0;
        idex_valid_q <= 1'b0;
      end else if (load_use_stall) begin
        idex_valid_q <= 1'b0;
      end else begin
        pc_q <= pc_q + 32'd4;
        ifid_valid_q <= 1'b1;
        ifid_pc_q <= pc_q;
        ifid_instr_q <= instr_rdata_i;
        idex_valid_q <= instr_valid;
        idex_pc_q <= ifid_pc_q;
        idex_pc4_q <= ifid_pc_q + 32'd4;
        idex_rs1_value_q <= instr_rs1_value;
        idex_rs2_value_q <= instr_rs2_value;
        idex_immediate_q <= instr_immediate;
        idex_rs1_q <= instr_rs1;
        idex_rs2_q <= instr_rs2;
        idex_rd_q <= instr_rd;
        idex_funct3_q <= instr_funct3;
        idex_alu_op_q <= instr_alu_op;
        idex_wb_sel_q <= instr_wb_sel;
        idex_branch_q <= instr_branch;
        idex_uses_pc_q <= instr_uses_pc;
        idex_uses_imm_q <= instr_uses_imm;
        idex_regwrite_q <= instr_regwrite;
        idex_memread_q <= instr_memread;
        idex_memwrite_q <= instr_memwrite;
      end
    end
  end
endmodule
